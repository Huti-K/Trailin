import { describe, expect, it } from "vitest";
import {
  normalizeAddressSet,
  normalizeSubject,
  sameAddressSet,
} from "../../../src/email/learn/addressSubject.js";

describe("normalizeAddressSet", () => {
  it("strips display names, lowercases, and dedupes", () => {
    const set = normalizeAddressSet([
      "Alice <Alice@Example.com>",
      "bob@example.com",
      "BOB@EXAMPLE.COM",
    ]);
    expect([...set].sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("drops blank entries", () => {
    expect(normalizeAddressSet(["", "  "]).size).toBe(0);
  });
});

describe("sameAddressSet", () => {
  it("is true for the same members in any order", () => {
    const a = normalizeAddressSet(["a@example.com", "b@example.com"]);
    const b = normalizeAddressSet(["B <b@example.com>", "A <a@example.com>"]);
    expect(sameAddressSet(a, b)).toBe(true);
  });

  it("is false when sizes differ", () => {
    const a = normalizeAddressSet(["a@example.com"]);
    const b = normalizeAddressSet(["a@example.com", "b@example.com"]);
    expect(sameAddressSet(a, b)).toBe(false);
  });

  it("is false when sizes match but members differ", () => {
    const a = normalizeAddressSet(["a@example.com"]);
    const b = normalizeAddressSet(["c@example.com"]);
    expect(sameAddressSet(a, b)).toBe(false);
  });
});

describe("normalizeSubject", () => {
  it("strips a single reply prefix, case-insensitively", () => {
    expect(normalizeSubject("Re: Project update")).toBe("project update");
    expect(normalizeSubject("RE:Project update")).toBe("project update");
  });

  it("strips forward and German reply prefixes", () => {
    expect(normalizeSubject("Fwd: Project update")).toBe("project update");
    expect(normalizeSubject("Fw: Project update")).toBe("project update");
    expect(normalizeSubject("AW: Project update")).toBe("project update");
  });

  it("strips a chain of nested prefixes", () => {
    expect(normalizeSubject("Re: Fwd: Re: Project update")).toBe("project update");
  });

  it("collapses whitespace and ignores case in the remainder", () => {
    expect(normalizeSubject("  Project   Update  ")).toBe("project update");
  });

  it("leaves a subject with no prefix untouched apart from case/whitespace", () => {
    expect(normalizeSubject("Project update")).toBe("project update");
  });
});
