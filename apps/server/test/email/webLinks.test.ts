import type { ConnectedAccount } from "@trailin/shared";
import { describe, expect, it } from "vitest";
import {
  isConsumerOutlookAccount,
  outlookWebRoot,
  threadWebUrl,
  withOutlookLoginHint,
} from "../../src/email/webLinks.js";

function account(app: string, name: string): ConnectedAccount {
  return { id: "acc-1", app, name, healthy: true, createdAt: "2026-01-01T00:00:00Z" };
}

describe("isConsumerOutlookAccount", () => {
  it.each([
    "a@hotmail.com",
    "a@hotmail.de",
    "a@outlook.com",
    "a@outlook.fr",
    "a@live.co.uk",
    "a@msn.com",
  ])("recognizes %s as a personal account", (name) => {
    expect(isConsumerOutlookAccount(name)).toBe(true);
  });

  it.each([
    "a@contoso.com",
    "a@outlookish.com",
    "a@liverpool.com",
    "Work account",
  ])("treats %s as work/school", (name) => {
    expect(isConsumerOutlookAccount(name)).toBe(false);
  });
});

describe("outlookWebRoot", () => {
  it("routes work accounts to the organizational host", () => {
    expect(outlookWebRoot("a@contoso.com")).toBe("https://outlook.office.com/mail/");
  });

  it("routes personal accounts to the consumer host", () => {
    expect(outlookWebRoot("a@hotmail.com")).toBe("https://outlook.live.com/mail/");
  });
});

describe("withOutlookLoginHint", () => {
  it("appends login_hint with ? to a bare URL", () => {
    expect(withOutlookLoginHint("https://outlook.office.com/mail/", "a@b.com")).toBe(
      "https://outlook.office.com/mail/?login_hint=a%40b.com",
    );
  });

  it("appends login_hint with & when the URL already has a query", () => {
    const webLink = "https://outlook.office365.com/owa/?ItemID=AAMk%2Bx%3D&exvsurl=1";
    expect(withOutlookLoginHint(webLink, "a@b.com")).toBe(`${webLink}&login_hint=a%40b.com`);
  });

  it("leaves the URL alone when the account name is not an email", () => {
    expect(withOutlookLoginHint("https://outlook.office.com/mail/", "Work account")).toBe(
      "https://outlook.office.com/mail/",
    );
  });
});

describe("threadWebUrl", () => {
  it("pins a work Outlook account to the organizational mailbox root", () => {
    expect(threadWebUrl(account("microsoft_outlook", "a@contoso.com"), "conv-1")).toBe(
      "https://outlook.office.com/mail/?login_hint=a%40contoso.com",
    );
  });

  it("pins a personal Outlook account to the consumer mailbox root", () => {
    expect(threadWebUrl(account("microsoft_outlook", "a@hotmail.com"), "conv-1")).toBe(
      "https://outlook.live.com/mail/?login_hint=a%40hotmail.com",
    );
  });

  it("builds a Gmail deep link with authuser", () => {
    expect(threadWebUrl(account("gmail", "a@b.com"), "t1")).toBe(
      "https://mail.google.com/mail/?authuser=a%40b.com#all/t1",
    );
  });

  it('returns "" for an app with no known web UI', () => {
    expect(threadWebUrl(account("notion", "Workspace"), "t1")).toBe("");
  });
});
