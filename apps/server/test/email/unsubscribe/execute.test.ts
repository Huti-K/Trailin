import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { executeOneClickUnsubscribe } from "../../../src/email/unsubscribe/execute.js";

/**
 * The real one-click POST is exercised against a genuine local HTTP server
 * (proving method/body/headers/redirect-handling actually work end to end);
 * https-only enforcement, error handling and the timeout path are exercised
 * with an injected fetch instead of a live TLS server — this module's own
 * `fetchImpl` parameter exists for exactly that (see its doc comment).
 */

describe("executeOneClickUnsubscribe — https enforcement", () => {
  it("refuses a plain http URL without making any request", async () => {
    const fetchImpl = vi.fn();
    const result = await executeOneClickUnsubscribe("http://example.com/unsub", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/https/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a mailto URL without making any request", async () => {
    const fetchImpl = vi.fn();
    const result = await executeOneClickUnsubscribe("mailto:unsub@example.com", fetchImpl);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("executeOneClickUnsubscribe — request shape", () => {
  it("POSTs the RFC 8058 body with the right content-type, no follow, no credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);

    expect(result).toEqual({ ok: true, status: 202 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.com/unsub");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("List-Unsubscribe=One-Click");
    expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
  });

  it("treats a redirect (3xx) as accepted, per RFC 8058's undefined-but-not-a-failure stance", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302 }));
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);
    expect(result).toEqual({ ok: true, status: 302 });
  });

  it("treats a 4xx as a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toMatch(/404/);
  });

  it("treats a 5xx as a failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it("reports a network failure as a clear, non-throwing result", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("reports an aborted (timed-out) request with a clear message", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    const result = await executeOneClickUnsubscribe("https://example.com/unsub", fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });
});

describe("executeOneClickUnsubscribe — live server (request actually reaches the network)", () => {
  let received: { method?: string; body: string; headers: Record<string, string> } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        method: req.method,
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers as Record<string, string>,
      };
      res.writeHead(200);
      res.end();
    });
  });

  afterAll(() => {
    server.close();
  });

  it("actually POSTs the fixed body to the given URL", async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const realUrl = `http://127.0.0.1:${port}/unsub`;

    // The https-only guard refuses this URL through the real entry point (the
    // local test server has no TLS cert to be a genuine https target), so
    // fetchImpl redirects the request to the real server while everything
    // else — method, body, headers, redirect: "manual" — is the module's own,
    // unmocked call, verified server-side below via `received`.
    await executeOneClickUnsubscribe(`https://127.0.0.1:${port}/unsub`, async (_url, init) =>
      fetch(realUrl, init),
    );

    expect(received).not.toBeNull();
    expect(received?.method).toBe("POST");
    expect(received?.body).toBe("List-Unsubscribe=One-Click");
    expect(received?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });
});
