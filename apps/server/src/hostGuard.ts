/**
 * DNS-rebinding defense: is this Host header allowed to reach the API?
 *
 * The CORS check in index.ts reflects only localhost-ish Origins but still
 * lets requests through with no Origin header at all — and a page served
 * from a domain whose DNS answer has been "rebound" to 127.0.0.1 issues
 * exactly those no-Origin, same-origin-looking requests from the browser's
 * point of view. The Host header is the one signal that survives the rebind
 * (it still says the attacker's domain, not this server's), so pinning it to
 * loopback names plus whatever host was deliberately configured closes the
 * hole without touching the CORS logic.
 */
export function isAllowedHost(hostHeader: string | undefined, configuredHost: string): boolean {
  const hostname = extractHostname(hostHeader);
  if (!hostname) return false;

  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (lower === "127.0.0.1" || lower === "::1") return true;
  // Deliberate LAN exposure (HOST=192.168.x.x etc.) — same host, any port.
  return lower === configuredHost.toLowerCase();
}

/**
 * Strips an optional `:port` suffix from a Host header value, unwrapping
 * IPv6 bracket syntax (`[::1]:3001`). Returns undefined for anything
 * missing, empty, or malformed rather than guessing.
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

  // A bare (unbracketed) IPv6 literal can't carry a port unambiguously —
  // only accept it whole, e.g. the literal "::1".
  if ((value.match(/:/g) ?? []).length > 1) return value;

  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) return value;
  const hostname = value.slice(0, colonIndex);
  const port = value.slice(colonIndex + 1);
  if (!/^\d+$/.test(port)) return undefined;
  return hostname || undefined;
}
