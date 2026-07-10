import { describe, it, expect } from "vitest";
import { isAllowedHost } from "../src/hostGuard.js";

describe("isAllowedHost", () => {
  const defaultHost = "127.0.0.1";

  describe("loopback hostnames", () => {
    it("allows localhost with no port", () => {
      expect(isAllowedHost("localhost", defaultHost)).toBe(true);
    });

    it("allows localhost with a port", () => {
      expect(isAllowedHost("localhost:3001", defaultHost)).toBe(true);
    });

    it("allows localhost case-insensitively", () => {
      expect(isAllowedHost("LOCALHOST:3001", defaultHost)).toBe(true);
    });

    it("allows a subdomain of localhost", () => {
      expect(isAllowedHost("foo.localhost:5173", defaultHost)).toBe(true);
    });

    it("allows a nested subdomain of localhost", () => {
      expect(isAllowedHost("a.b.localhost", defaultHost)).toBe(true);
    });

    it("allows 127.0.0.1 with no port", () => {
      expect(isAllowedHost("127.0.0.1", defaultHost)).toBe(true);
    });

    it("allows 127.0.0.1 with a port", () => {
      expect(isAllowedHost("127.0.0.1:3001", defaultHost)).toBe(true);
    });

    it("allows the bare IPv6 loopback literal ::1", () => {
      expect(isAllowedHost("::1", defaultHost)).toBe(true);
    });

    it("allows the bracketed IPv6 loopback literal [::1]", () => {
      expect(isAllowedHost("[::1]", defaultHost)).toBe(true);
    });

    it("allows the bracketed IPv6 loopback literal with a port", () => {
      expect(isAllowedHost("[::1]:3001", defaultHost)).toBe(true);
    });
  });

  describe("configured LAN host", () => {
    it("allows the exact configured host with no port", () => {
      expect(isAllowedHost("192.168.1.50", "192.168.1.50")).toBe(true);
    });

    it("allows the exact configured host with a port", () => {
      expect(isAllowedHost("192.168.1.50:3001", "192.168.1.50")).toBe(true);
    });

    it("allows the configured host case-insensitively", () => {
      expect(isAllowedHost("MY-HOST:3001", "my-host")).toBe(true);
    });

    it("rejects a different LAN address than the one configured", () => {
      expect(isAllowedHost("192.168.1.51:3001", "192.168.1.50")).toBe(false);
    });

    it("does not allow the configured host when it isn't set to a LAN address (default stays loopback-only)", () => {
      expect(isAllowedHost("192.168.1.50:3001", "127.0.0.1")).toBe(false);
    });
  });

  describe("rebinding / spoofing attempts", () => {
    it("rejects an attacker-controlled domain", () => {
      expect(isAllowedHost("attacker.com", defaultHost)).toBe(false);
    });

    it("rejects an attacker domain with a loopback-looking subdomain prefix", () => {
      expect(isAllowedHost("127.0.0.1.attacker.com", defaultHost)).toBe(false);
    });

    it("rejects an attacker domain crafted to look like a localhost suffix", () => {
      expect(isAllowedHost("localhost.attacker.com", defaultHost)).toBe(false);
    });

    it("rejects a host that merely contains 'localhost' without being a subdomain of it", () => {
      expect(isAllowedHost("notlocalhost", defaultHost)).toBe(false);
    });

    it("rejects trailing-dot localhost (not an exact or subdomain match)", () => {
      expect(isAllowedHost("localhost.:3001", defaultHost)).toBe(false);
    });
  });

  describe("malformed / missing input", () => {
    it("rejects undefined", () => {
      expect(isAllowedHost(undefined, defaultHost)).toBe(false);
    });

    it("rejects an empty string", () => {
      expect(isAllowedHost("", defaultHost)).toBe(false);
    });

    it("rejects a whitespace-only string", () => {
      expect(isAllowedHost("   ", defaultHost)).toBe(false);
    });

    it("rejects a non-numeric port suffix", () => {
      expect(isAllowedHost("localhost:abc", defaultHost)).toBe(false);
    });

    it("rejects an unclosed IPv6 bracket", () => {
      expect(isAllowedHost("[::1", defaultHost)).toBe(false);
    });

    it("rejects trailing garbage after a closed IPv6 bracket", () => {
      expect(isAllowedHost("[::1]extra", defaultHost)).toBe(false);
    });

    it("rejects a port-only header with no hostname", () => {
      expect(isAllowedHost(":3001", defaultHost)).toBe(false);
    });

    it("rejects an empty bracketed host", () => {
      expect(isAllowedHost("[]:3001", defaultHost)).toBe(false);
    });
  });
});
