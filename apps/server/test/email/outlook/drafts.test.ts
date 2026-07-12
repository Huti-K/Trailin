import type { ConnectedAccount } from "@trailin/shared";
import { describe, expect, it, vi } from "vitest";

// outlookDraftProvider drives every fetch through proxyRequest — stub it the
// same way ./sync.test.ts does, instead of hitting Pipedream's proxy for real.
const proxyRequestMock =
  vi.fn<
    (
      accountId: string,
      method: string,
      url: string,
      opts?: { params?: Record<string, string> },
    ) => Promise<unknown>
  >();
vi.mock("../../../src/pipedream/connect.js", () => ({
  proxyRequest: (...args: Parameters<typeof proxyRequestMock>) => proxyRequestMock(...args),
}));

const { outlookDraftProvider } = await import("../../../src/email/outlook/drafts.js");

function account(name: string): ConnectedAccount {
  return {
    id: "acct-1",
    app: "microsoft_outlook",
    appName: "Outlook",
    name,
    healthy: true,
    createdAt: "2026-01-01",
  };
}

const WEB_LINK = "https://outlook.office365.com/owa/?ItemID=AAMk%2Bx%3D&exvsurl=1";

function listResponse(webLink?: string) {
  return { value: [{ id: "d1", subject: "Hi", ...(webLink ? { webLink } : {}) }] };
}

describe("listOutlookDrafts — webUrl per account class", () => {
  it("pins Graph's webLink to a work account via login_hint", async () => {
    proxyRequestMock.mockResolvedValueOnce(listResponse(WEB_LINK));
    const drafts = await outlookDraftProvider.listDrafts(account("a@contoso.com"));
    expect(drafts[0]?.webUrl).toBe(`${WEB_LINK}&login_hint=a%40contoso.com`);
  });

  it("ignores webLink for a personal account and lands on the consumer Drafts folder", async () => {
    proxyRequestMock.mockResolvedValueOnce(listResponse(WEB_LINK));
    const drafts = await outlookDraftProvider.listDrafts(account("a@hotmail.com"));
    expect(drafts[0]?.webUrl).toBe(
      "https://outlook.live.com/mail/0/drafts?login_hint=a%40hotmail.com",
    );
  });

  it("falls back to the work Drafts folder when Graph omits webLink", async () => {
    proxyRequestMock.mockResolvedValueOnce(listResponse());
    const drafts = await outlookDraftProvider.listDrafts(account("a@contoso.com"));
    expect(drafts[0]?.webUrl).toBe(
      "https://outlook.office.com/mail/drafts?login_hint=a%40contoso.com",
    );
  });
});
