import { errorMessage } from "../../util.js";

/**
 * RFC 8058 one-click unsubscribe: POST to the sender-supplied https URL with
 * a fixed body, no cookies, and no auth headers — the mechanism exists
 * precisely so a mail client can fire this without ever authenticating as
 * the recipient. `redirect: "manual"` means a 3xx comes back as a normal
 * response instead of being followed, so a Location header (to anywhere,
 * https or not) is never itself fetched; RFC 8058 doesn't define what a
 * redirect here means, so it's treated as accepted, same as a plain 2xx.
 * GET is never used — the whole point of List-Unsubscribe-Post existing is
 * that a bare GET must not be able to unsubscribe anyone (crawlers, link
 * scanners, proxies all issue GETs).
 */

export interface UnsubscribeExecuteResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/**
 * `fetchImpl` exists only for tests (a real https certificate isn't
 * practical to stand up for a unit test) — every real caller uses the
 * default, the global fetch.
 */
export async function executeOneClickUnsubscribe(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UnsubscribeExecuteResult> {
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, error: "one-click unsubscribe requires an https URL" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ONE_CLICK_BODY,
      redirect: "manual",
      credentials: "omit",
      signal: controller.signal,
    });
    if (res.status >= 400) {
      return { ok: false, status: res.status, error: `sender responded ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ok: false, error: timedOut ? "unsubscribe request timed out" : errorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}
