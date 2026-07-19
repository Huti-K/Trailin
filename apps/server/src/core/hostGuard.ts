import { isIP } from "node:net";

/**
 * DNS-rebinding defense: is this Host header allowed to reach the API?
 *
 * CORS (app.ts) reflects only loopback Origins but still lets no-Origin
 * requests through, and a page whose DNS was rebound to 127.0.0.1 issues
 * exactly those no-Origin, same-origin-looking requests. The Host header
 * survives the rebind (it still names the attacker's domain), so the guard
 * admits only:
 *
 * - loopback names (localhost, *.localhost, 127.0.0.1, ::1),
 * - IP literals: a rebind needs a domain name in the URL, so an IP as Host was
 *   reached directly. This is what lets deliberate LAN exposure (HOST=0.0.0.0)
 *   accept requests to whichever machine IP the client used,
 * - the configured host itself, for a non-IP HOST value (e.g. an mDNS name).
 */
export function isAllowedHost(hostHeader: string | undefined, configuredHost: string): boolean {
  const hostname = extractHostname(hostHeader);
  if (!hostname) return false;

  const lower = hostname.toLowerCase();
  if (isLoopbackHostname(lower)) return true;
  if (isIP(lower) !== 0) return true;
  return lower === configuredHost.toLowerCase();
}

/** Loopback names, the set shared by the host guard and the CORS origin check. */
export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "127.0.0.1" ||
    lower === "::1"
  );
}

/**
 * Whether an Origin header names a loopback web page (any port); the set the
 * CORS layer reflects. Anything unparseable or non-http(s) is rejected.
 */
export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]").
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return isLoopbackHostname(hostname);
}

/**
 * Strips an optional :port suffix from a Host header, unwrapping IPv6 bracket
 * syntax ([::1]:3001). Returns undefined for anything missing, empty, or
 * malformed rather than guessing.
 */
function extractHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim();
  if (!value) return undefined;

  if (value.startsWith("[")) {
    const closeIndex = value.indexOf("]");
    if (closeIndex === -1) return undefined;
    const hostname = value.slice(1, closeIndex);
    const rest = value.slice(closeIndex + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return undefined;
    return hostname || undefined;
  }

  // A bare (unbracketed) IPv6 literal can't carry a port unambiguously, so
  // accept it whole (e.g. the literal "::1").
  if ((value.match(/:/g) ?? []).length > 1) return value;

  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) return value;
  const hostname = value.slice(0, colonIndex);
  const port = value.slice(colonIndex + 1);
  if (!/^\d+$/.test(port)) return undefined;
  return hostname || undefined;
}
