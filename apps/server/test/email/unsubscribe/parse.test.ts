import { describe, expect, it } from "vitest";
import { classifyParsed, parseListUnsubscribe } from "../../../src/email/unsubscribe/parse.js";

describe("parseListUnsubscribe", () => {
  it("state one_click: an https entry plus List-Unsubscribe-Post becomes oneClickUrl", () => {
    const parsed = parseListUnsubscribe(
      "<mailto:unsub@example.com>, <https://example.com/unsub?id=1>",
      true,
    );
    expect(parsed).toEqual({ oneClickUrl: "https://example.com/unsub?id=1", mailtoOnly: false });
  });

  it("state browse: an https entry with no List-Unsubscribe-Post becomes browseUrl", () => {
    const parsed = parseListUnsubscribe("<https://example.com/unsub?id=2>", false);
    expect(parsed).toEqual({ browseUrl: "https://example.com/unsub?id=2", mailtoOnly: false });
  });

  it("state mailto_only: only mailto entries sets mailtoOnly, no post header", () => {
    const parsed = parseListUnsubscribe("<mailto:unsub@example.com>", false);
    expect(parsed).toEqual({ mailtoOnly: true });
  });

  it("state mailto_only: only mailto entries even when the Post header is (incorrectly) present", () => {
    const parsed = parseListUnsubscribe("<mailto:unsub@example.com>", true);
    expect(parsed).toEqual({ mailtoOnly: true });
  });

  it("state none: an empty header value yields neither a URL nor mailtoOnly", () => {
    const parsed = parseListUnsubscribe("", true);
    expect(parsed).toEqual({ mailtoOnly: false });
  });

  it("rejects http (non-https) entries outright, even alone", () => {
    const parsed = parseListUnsubscribe("<http://example.com/unsub>", true);
    expect(parsed).toEqual({ mailtoOnly: false });
  });

  it("rejects http entries but still honors a mailto fallback alongside them", () => {
    const parsed = parseListUnsubscribe(
      "<http://example.com/unsub>, <mailto:unsub@example.com>",
      true,
    );
    expect(parsed).toEqual({ mailtoOnly: true });
  });

  it("prefers the https entry over a co-occurring http entry", () => {
    const parsed = parseListUnsubscribe(
      "<http://example.com/unsub>, <https://example.com/unsub-secure>",
      true,
    );
    expect(parsed).toEqual({ oneClickUrl: "https://example.com/unsub-secure", mailtoOnly: false });
  });

  it("is case-insensitive on the https scheme", () => {
    const parsed = parseListUnsubscribe("<HTTPS://example.com/unsub>", true);
    expect(parsed.oneClickUrl).toBe("HTTPS://example.com/unsub");
  });

  it("ignores an unbracketed or malformed entry", () => {
    const parsed = parseListUnsubscribe("not-a-uri-entry", true);
    expect(parsed).toEqual({ mailtoOnly: false });
  });

  it("picks the first https entry when several are present", () => {
    const parsed = parseListUnsubscribe(
      "<https://a.example.com/unsub>, <https://b.example.com/unsub>",
      false,
    );
    expect(parsed.browseUrl).toBe("https://a.example.com/unsub");
  });
});

describe("classifyParsed", () => {
  it("maps oneClickUrl to state one_click", () => {
    expect(classifyParsed({ oneClickUrl: "https://x.example.com", mailtoOnly: false })).toEqual({
      state: "one_click",
    });
  });

  it("maps browseUrl to state browse, carrying the URL through", () => {
    expect(classifyParsed({ browseUrl: "https://x.example.com", mailtoOnly: false })).toEqual({
      state: "browse",
      browseUrl: "https://x.example.com",
    });
  });

  it("maps mailtoOnly to state mailto_only", () => {
    expect(classifyParsed({ mailtoOnly: true })).toEqual({ state: "mailto_only" });
  });

  it("maps nothing usable to state none", () => {
    expect(classifyParsed({ mailtoOnly: false })).toEqual({ state: "none" });
  });

  it("never returns state unknown", () => {
    const states = [
      classifyParsed({ oneClickUrl: "https://x.example.com", mailtoOnly: false }).state,
      classifyParsed({ browseUrl: "https://x.example.com", mailtoOnly: false }).state,
      classifyParsed({ mailtoOnly: true }).state,
      classifyParsed({ mailtoOnly: false }).state,
    ];
    expect(states).not.toContain("unknown");
  });
});
