import { describe, expect, it } from "vitest";
import { isEmailLike, parseAddressEntry } from "../../../src/email/contacts/addressMatch.js";

describe("parseAddressEntry", () => {
  it("splits a display name from its angle-bracketed address", () => {
    expect(parseAddressEntry("Alice Smith <alice@example.com>")).toEqual({
      address: "alice@example.com",
      name: "Alice Smith",
    });
  });

  it("lowercases the address but leaves the name's case alone", () => {
    expect(parseAddressEntry("Alice Smith <Alice@Example.COM>")).toEqual({
      address: "alice@example.com",
      name: "Alice Smith",
    });
  });

  it("treats a bare address as having no name", () => {
    expect(parseAddressEntry("bob@example.com")).toEqual({ address: "bob@example.com", name: "" });
  });

  it("strips surrounding quotes from the name", () => {
    expect(parseAddressEntry('"Kaya, Ayse" <a@x.com>')).toEqual({
      address: "a@x.com",
      name: "Kaya, Ayse",
    });
  });

  it("trims surrounding whitespace on both address and name", () => {
    expect(parseAddressEntry("  Carol  <  carol@example.com  >  ")).toEqual({
      address: "carol@example.com",
      name: "Carol",
    });
  });

  it("falls back to a lowercased bare token for malformed input", () => {
    expect(parseAddressEntry("Not An Address")).toEqual({ address: "not an address", name: "" });
  });
});

describe("isEmailLike", () => {
  it("accepts a plausible bare address", () => {
    expect(isEmailLike("bob@example.com")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isEmailLike("")).toBe(false);
  });

  it("rejects a token with no @", () => {
    expect(isEmailLike("not-an-address")).toBe(false);
  });

  it("rejects a token containing whitespace (a parse fallback, not a real address)", () => {
    expect(isEmailLike("not an address")).toBe(false);
  });
});
