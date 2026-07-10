import { describe, it, expect } from "vitest";
import { headerLookup, plainTextBody, decodeHtmlEntities, type MessagePart } from "../../src/email/gmailMessage.js";

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

describe("headerLookup", () => {
  it("matches header names case-insensitively", () => {
    const lookup = headerLookup({ headers: [{ name: "Subject", value: "Hello" }] });
    expect(lookup("subject")).toBe("Hello");
    expect(lookup("SUBJECT")).toBe("Hello");
    expect(lookup("Subject")).toBe("Hello");
  });

  it("returns an empty string for a missing header", () => {
    const lookup = headerLookup({ headers: [{ name: "Subject", value: "Hello" }] });
    expect(lookup("From")).toBe("");
  });

  it("returns an empty string when payload is undefined", () => {
    const lookup = headerLookup(undefined);
    expect(lookup("Subject")).toBe("");
  });
});

describe("plainTextBody", () => {
  it("reads a top-level text/plain part", () => {
    const payload: MessagePart = {
      mimeType: "text/plain",
      body: { data: b64("hello world") },
    };
    expect(plainTextBody(payload)).toBe("hello world");
  });

  it("finds text/plain nested deep inside multipart parts", () => {
    const payload: MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "multipart/related",
              parts: [{ mimeType: "text/plain", body: { data: b64("nested plain") } }],
            },
          ],
        },
      ],
    };
    expect(plainTextBody(payload)).toBe("nested plain");
  });

  it("falls back to text/html with tags stripped when no text/plain exists", () => {
    const payload: MessagePart = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: b64("<p>hi <b>there</b></p>") } }],
    };
    expect(plainTextBody(payload)).toBe("hi there");
  });

  it("returns an empty string for an undefined payload", () => {
    expect(plainTextBody(undefined)).toBe("");
  });

  it("returns an empty string when no matching part has body.data", () => {
    const payload: MessagePart = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/plain" }, { mimeType: "text/html" }],
    };
    expect(plainTextBody(payload)).toBe("");
  });

  it("prefers text/plain over text/html when both exist", () => {
    const payload: MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>html body</p>") } },
        { mimeType: "text/plain", body: { data: b64("plain body") } },
      ],
    };
    expect(plainTextBody(payload)).toBe("plain body");
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the known entities", () => {
    expect(decodeHtmlEntities("&amp;")).toBe("&");
    expect(decodeHtmlEntities("&lt;")).toBe("<");
    expect(decodeHtmlEntities("&gt;")).toBe(">");
    expect(decodeHtmlEntities("&quot;")).toBe('"');
    expect(decodeHtmlEntities("&#39;")).toBe("'");
    expect(decodeHtmlEntities("&nbsp;")).toBe(" ");
  });

  it("decodes multiple entities within surrounding text", () => {
    expect(decodeHtmlEntities("Tom &amp; Jerry &quot;fun&quot;")).toBe('Tom & Jerry "fun"');
  });

  it("leaves other text and unknown entities untouched", () => {
    expect(decodeHtmlEntities("plain text")).toBe("plain text");
    expect(decodeHtmlEntities("&copy; 2024")).toBe("&copy; 2024");
  });
});
