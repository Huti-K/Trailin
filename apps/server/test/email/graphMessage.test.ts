import { describe, it, expect } from "vitest";
import {
  formatRecipient,
  formatRecipients,
  recipientAddresses,
  addressListOf,
  newestByReceivedDate,
  type GraphRecipient,
} from "../../src/email/graphMessage.js";

describe("formatRecipient", () => {
  it("formats name and address as 'Name <addr>'", () => {
    const recipient: GraphRecipient = { emailAddress: { name: "Alice", address: "alice@x.com" } };
    expect(formatRecipient(recipient)).toBe("Alice <alice@x.com>");
  });

  it("returns the bare address when only an address is given", () => {
    const recipient: GraphRecipient = { emailAddress: { address: "alice@x.com" } };
    expect(formatRecipient(recipient)).toBe("alice@x.com");
  });

  it("returns the bare address when name === address", () => {
    const recipient: GraphRecipient = {
      emailAddress: { name: "alice@x.com", address: "alice@x.com" },
    };
    expect(formatRecipient(recipient)).toBe("alice@x.com");
  });

  it("returns the name when only a name is given", () => {
    const recipient: GraphRecipient = { emailAddress: { name: "Alice" } };
    expect(formatRecipient(recipient)).toBe("Alice");
  });

  it("returns undefined for an undefined recipient", () => {
    expect(formatRecipient(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty emailAddress", () => {
    expect(formatRecipient({ emailAddress: {} })).toBeUndefined();
  });

  it("treats a whitespace-only address as missing", () => {
    const recipient: GraphRecipient = { emailAddress: { name: "Alice", address: "   " } };
    expect(formatRecipient(recipient)).toBe("Alice");
  });

  it("returns undefined when address is whitespace-only and no name is given", () => {
    const recipient: GraphRecipient = { emailAddress: { address: "   " } };
    expect(formatRecipient(recipient)).toBeUndefined();
  });
});

describe("formatRecipients", () => {
  it("drops entries that resolve to undefined", () => {
    const recipients: GraphRecipient[] = [
      { emailAddress: { name: "Alice", address: "alice@x.com" } },
      { emailAddress: {} },
      { emailAddress: { address: "bob@y.com" } },
    ];
    expect(formatRecipients(recipients)).toEqual(["Alice <alice@x.com>", "bob@y.com"]);
  });

  it("returns an empty array for undefined recipients", () => {
    expect(formatRecipients(undefined)).toEqual([]);
  });
});

describe("recipientAddresses", () => {
  it("returns bare addresses even when names exist", () => {
    const recipients: GraphRecipient[] = [
      { emailAddress: { name: "Alice", address: "alice@x.com" } },
      { emailAddress: { name: "Bob", address: "bob@y.com" } },
    ];
    expect(recipientAddresses(recipients)).toEqual(["alice@x.com", "bob@y.com"]);
  });

  it("drops entries that resolve to undefined", () => {
    const recipients: GraphRecipient[] = [
      { emailAddress: { name: "Alice", address: "alice@x.com" } },
      { emailAddress: {} },
    ];
    expect(recipientAddresses(recipients)).toEqual(["alice@x.com"]);
  });

  it("returns an empty array for undefined recipients", () => {
    expect(recipientAddresses(undefined)).toEqual([]);
  });
});

describe("addressListOf", () => {
  it("joins bare addresses with ', '", () => {
    const recipients: GraphRecipient[] = [
      { emailAddress: { name: "Alice", address: "alice@x.com" } },
      { emailAddress: { name: "Bob", address: "bob@y.com" } },
    ];
    expect(addressListOf(recipients)).toBe("alice@x.com, bob@y.com");
  });

  it("returns an empty string for undefined recipients", () => {
    expect(addressListOf(undefined)).toBe("");
  });
});

describe("newestByReceivedDate", () => {
  it("returns the item with the latest receivedDateTime, regardless of input order", () => {
    const items = [
      { id: "a", receivedDateTime: "2026-01-01T00:00:00Z" },
      { id: "c", receivedDateTime: "2026-03-01T00:00:00Z" },
      { id: "b", receivedDateTime: "2026-02-01T00:00:00Z" },
    ];
    expect(newestByReceivedDate(items)?.id).toBe("c");
  });

  it("returns undefined for an empty list", () => {
    expect(newestByReceivedDate([])).toBeUndefined();
  });

  it("treats a missing receivedDateTime as the oldest", () => {
    const items = [
      { id: "a", receivedDateTime: undefined },
      { id: "b", receivedDateTime: "2026-01-01T00:00:00Z" },
    ];
    expect(newestByReceivedDate(items)?.id).toBe("b");
  });

  it("keeps the first item when every receivedDateTime is missing", () => {
    const items = [
      { id: "a", receivedDateTime: undefined },
      { id: "b", receivedDateTime: undefined },
    ];
    expect(newestByReceivedDate(items)?.id).toBe("a");
  });
});
