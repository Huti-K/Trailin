import { describe, expect, it } from "vitest";
import {
  coerceBriefingItem,
  coerceBriefingRollup,
  isBriefingPriority,
  parseAgentCard,
} from "../../src/agent/cards.js";

// coerceBriefingItem/coerceBriefingRollup are shared between briefingTool.ts's
// compose_briefing tool (which resolves an accountId itself before calling
// them) and parseAgentCard's "briefing" arm below (which trusts a card's
// accountId field directly) — these tests cover the shared rules directly,
// plus one end-to-end parseAgentCard check that the "briefing" arm still
// wires accountId through correctly.

const validItem = {
  threadId: "t1",
  sender: "Ayşe Kaya",
  subject: "Contract renewal",
  gist: "Wants to renew before Friday.",
  priority: "urgent",
};

describe("coerceBriefingItem", () => {
  it("keeps a fully valid item, including the given accountId", () => {
    const item = coerceBriefingItem(validItem, "acc-1", undefined);
    expect(item).toEqual({
      threadId: "t1",
      accountId: "acc-1",
      sender: "Ayşe Kaya",
      subject: "Contract renewal",
      gist: "Wants to renew before Friday.",
      priority: "urgent",
    });
  });

  it("omits accountId when none is given", () => {
    const item = coerceBriefingItem(validItem, undefined, undefined);
    expect(item?.accountId).toBeUndefined();
  });

  it("includes the given webUrl", () => {
    const item = coerceBriefingItem(validItem, "acc-1", "https://mail.google.com/mail/#all/t1");
    expect(item?.webUrl).toBe("https://mail.google.com/mail/#all/t1");
  });

  it("omits webUrl when none is given, ignoring any webUrl on the raw value", () => {
    // webUrl is server-resolved (like accountId), never trusted off the raw
    // model-supplied record — a value on `validItem` itself must be ignored.
    const item = coerceBriefingItem(
      { ...validItem, webUrl: "https://evil.example" },
      "acc-1",
      undefined,
    );
    expect(item?.webUrl).toBeUndefined();
  });

  it("drops non-record input", () => {
    expect(coerceBriefingItem("not an object", "acc-1", undefined)).toBeUndefined();
    expect(coerceBriefingItem(null, "acc-1", undefined)).toBeUndefined();
    expect(coerceBriefingItem(undefined, "acc-1", undefined)).toBeUndefined();
  });

  it.each([
    "threadId",
    "sender",
    "subject",
    "gist",
  ])("drops an item missing required field %s", (field) => {
    const { [field]: _omit, ...rest } = validItem as Record<string, unknown>;
    expect(coerceBriefingItem(rest, "acc-1", undefined)).toBeUndefined();
  });

  it.each([
    "threadId",
    "sender",
    "subject",
    "gist",
  ])("drops an item whose required field %s is an empty/whitespace string", (field) => {
    expect(
      coerceBriefingItem({ ...validItem, [field]: "   " }, "acc-1", undefined),
    ).toBeUndefined();
  });

  it("degrades an unrecognized priority to fyi instead of dropping the item", () => {
    const item = coerceBriefingItem({ ...validItem, priority: "urgent-ish" }, "acc-1", undefined);
    expect(item?.priority).toBe("fyi");
  });

  it("drops optional string fields that are empty rather than keeping blanks", () => {
    const item = coerceBriefingItem(
      { ...validItem, messageId: "", deadline: "" },
      "acc-1",
      undefined,
    );
    expect(item?.messageId).toBeUndefined();
    expect(item?.deadline).toBeUndefined();
  });

  it("keeps populated optional fields", () => {
    const item = coerceBriefingItem(
      { ...validItem, messageId: "m1", deadline: "Friday 17:00", draftId: "d1" },
      "acc-1",
      undefined,
    );
    expect(item).toMatchObject({ messageId: "m1", deadline: "Friday 17:00", draftId: "d1" });
  });
});

const validRollup = { label: "Newsletters", count: 3 };

describe("coerceBriefingRollup", () => {
  it("keeps a valid rollup, including the given accountId", () => {
    const rollup = coerceBriefingRollup(validRollup, "acc-1");
    expect(rollup).toEqual({ accountId: "acc-1", label: "Newsletters", count: 3 });
  });

  it("drops non-record input", () => {
    expect(coerceBriefingRollup("nope", "acc-1")).toBeUndefined();
  });

  it("drops a rollup with an empty label", () => {
    expect(coerceBriefingRollup({ ...validRollup, label: "" }, "acc-1")).toBeUndefined();
  });

  it("drops a rollup with a non-finite count", () => {
    expect(coerceBriefingRollup({ ...validRollup, count: Number.NaN }, "acc-1")).toBeUndefined();
    expect(coerceBriefingRollup({ ...validRollup, count: "3" }, "acc-1")).toBeUndefined();
  });

  it("clamps a negative or fractional count to a non-negative integer", () => {
    expect(coerceBriefingRollup({ ...validRollup, count: -2.6 }, "acc-1")?.count).toBe(0);
    expect(coerceBriefingRollup({ ...validRollup, count: 3.6 }, "acc-1")?.count).toBe(4);
  });

  it("keeps a non-empty examples array (toStringArray only filters non-strings)", () => {
    const rollup = coerceBriefingRollup(
      { ...validRollup, examples: ["Ada", "", "Grace"] },
      undefined,
    );
    expect(rollup?.examples).toEqual(["Ada", "", "Grace"]);
  });

  it("drops the examples field entirely for a non-array, non-string value", () => {
    const rollup = coerceBriefingRollup({ ...validRollup, examples: 42 }, undefined);
    expect(rollup?.examples).toBeUndefined();
  });
});

describe("isBriefingPriority", () => {
  it("accepts every declared priority", () => {
    for (const p of ["urgent", "reply", "action", "fyi"]) {
      expect(isBriefingPriority(p)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isBriefingPriority("urgentish")).toBe(false);
    expect(isBriefingPriority(undefined)).toBe(false);
  });
});

describe("parseAgentCard briefing arm", () => {
  it("wires each item's accountId through from the raw details", () => {
    const card = parseAgentCard({
      kind: "briefing",
      items: [{ ...validItem, accountId: "acc-2" }],
    });
    expect(card?.kind).toBe("briefing");
    expect(card?.kind === "briefing" && card.items[0]?.accountId).toBe("acc-2");
  });

  it("wires each item's webUrl through from the raw details (a stored card's own field, trusted like accountId)", () => {
    const card = parseAgentCard({
      kind: "briefing",
      items: [{ ...validItem, webUrl: "https://mail.google.com/mail/#all/t1" }],
    });
    expect(card?.kind === "briefing" && card.items[0]?.webUrl).toBe(
      "https://mail.google.com/mail/#all/t1",
    );
  });

  it("drops a malformed item without failing the whole card", () => {
    const card = parseAgentCard({
      kind: "briefing",
      items: [{ ...validItem }, { subject: "missing everything else" }],
    });
    expect(card?.kind === "briefing" && card.items.length).toBe(1);
  });

  it("returns undefined for a briefing with no items array", () => {
    expect(parseAgentCard({ kind: "briefing" })).toBeUndefined();
  });
});

describe("parseAgentCard email_hits arm", () => {
  const hit = {
    messageId: "m1",
    threadId: "t1",
    accountId: "acc-1",
    subject: "Hello",
    from: "alice@example.com",
    to: ["bob@example.com"],
    date: "2026-01-01T00:00:00.000Z",
    snippet: "snippet text",
  };

  it("passes through accountId when the hit carries one", () => {
    const card = parseAgentCard({ kind: "email_hits", hits: [hit] });
    expect(card?.kind === "email_hits" && card.hits[0]?.accountId).toBe("acc-1");
  });

  it("omits accountId when the hit doesn't carry one", () => {
    const { accountId: _omit, ...bare } = hit;
    const card = parseAgentCard({ kind: "email_hits", hits: [bare] });
    expect(card?.kind === "email_hits" && card.hits[0]?.accountId).toBeUndefined();
  });
});

describe("parseAgentCard choices arm", () => {
  const validOption = {
    label: "work@example.com",
    detail: "Contract renewal",
    reply: "The work one, please.",
    ref: { threadId: "t1", accountId: "acc-1", accountName: "work@example.com" },
  };

  it("round-trips a valid card, including the option's ref", () => {
    const card = parseAgentCard({
      kind: "choices",
      question: "Which account do you mean?",
      options: [validOption],
    });
    expect(card).toEqual({
      kind: "choices",
      question: "Which account do you mean?",
      options: [validOption],
    });
  });

  it("keeps an option without a ref", () => {
    const { ref: _omit, ...bare } = validOption;
    const card = parseAgentCard({
      kind: "choices",
      question: "Pick one",
      options: [bare, validOption],
    });
    expect(card?.kind === "choices" && card.options).toHaveLength(2);
    expect(card?.kind === "choices" && card.options[0]?.ref).toBeUndefined();
  });

  it("drops an option missing a label, keeping the rest", () => {
    const card = parseAgentCard({
      kind: "choices",
      question: "Pick one",
      options: [validOption, { detail: "no label here" }],
    });
    expect(card?.kind === "choices" && card.options).toHaveLength(1);
  });

  it("drops a ref missing accountId from the option, but keeps the option itself", () => {
    const card = parseAgentCard({
      kind: "choices",
      question: "Pick one",
      options: [{ label: "Ayşe", ref: { threadId: "t1" } }],
    });
    expect(card?.kind === "choices" && card.options).toHaveLength(1);
    expect(card?.kind === "choices" && card.options[0]?.ref).toBeUndefined();
    expect(card?.kind === "choices" && card.options[0]?.label).toBe("Ayşe");
  });

  it("returns undefined for a card with zero valid options", () => {
    expect(
      parseAgentCard({
        kind: "choices",
        question: "Pick one",
        options: [{ detail: "no label" }, {}],
      }),
    ).toBeUndefined();
  });

  it("returns undefined without a non-empty question", () => {
    expect(
      parseAgentCard({ kind: "choices", question: "", options: [validOption] }),
    ).toBeUndefined();
    expect(parseAgentCard({ kind: "choices", options: [validOption] })).toBeUndefined();
  });

  it("returns undefined without an options array", () => {
    expect(parseAgentCard({ kind: "choices", question: "Pick one" })).toBeUndefined();
  });
});
