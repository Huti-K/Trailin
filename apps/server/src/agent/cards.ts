import {
  type AgentCard,
  BRIEFING_PRIORITIES,
  type BriefingItem,
  type BriefingPriority,
  type BriefingRollup,
  type CardAccount,
  type ChoiceOption,
  type ConnectedAccount,
  type DraftPreview,
  type EmailHit,
  type EmailThreadMessage,
  type MessageCard,
} from "@trailin/shared";
import { isNonEmptyString, isRecord } from "../util.js";
import { parseEmailRef } from "./emailRefs.js";

/**
 * Validates tool `details` payloads into `AgentCard`s the chat can render.
 * `parseAgentCard` is the last line of defense before a card reaches the
 * client: `details` is `unknown` by the time it gets here (it round-trips
 * through pi's event stream as `any`), so every field is checked rather
 * than trusted, and nothing here ever throws. The cards themselves are
 * built by our own tools (mailTools, the draft tool, briefingTool, choicesTool)
 * from typed local data.
 */

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Coerces a header-ish value (string, string[], or anything else) to string[]. */
function toStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const arr = value.filter(isString);
    return arr.length > 0 ? arr : undefined;
  }
  return isString(value) && value.length > 0 ? [value] : undefined;
}

/** Maps a resolved connected account onto the card's account slot. */
export function toCardAccount(account: ConnectedAccount): CardAccount {
  return {
    accountId: account.id,
    name: account.name,
    app: account.app,
    appName: account.appName,
    imgSrc: account.imgSrc,
  };
}

function parseCardAccount(value: unknown): CardAccount | undefined {
  if (!isRecord(value)) return undefined;
  const { accountId, name, app, appName, imgSrc } = value;
  if (!isString(accountId) || !isString(name) || !isString(app)) return undefined;
  return {
    accountId,
    name,
    app,
    ...(isString(appName) ? { appName } : {}),
    ...(isString(imgSrc) ? { imgSrc } : {}),
  };
}

function parseEmailHit(value: unknown): EmailHit | undefined {
  if (!isRecord(value)) return undefined;
  const { messageId, threadId, accountId, subject, from, to, date, snippet } = value;
  if (!isString(messageId) || !isString(threadId) || !isString(from)) return undefined;
  return {
    messageId,
    threadId,
    ...(isNonEmptyString(accountId) ? { accountId } : {}),
    subject: isString(subject) ? subject : "",
    from,
    to: toStringArray(to) ?? [],
    date: isString(date) ? date : "",
    snippet: isString(snippet) ? snippet : "",
  };
}

function parseEmailThreadMessage(value: unknown): EmailThreadMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { from, to, cc, date, body } = value;
  if (!isString(from) || !isString(body)) return undefined;
  const ccList = toStringArray(cc);
  return {
    from,
    to: toStringArray(to) ?? [],
    ...(ccList ? { cc: ccList } : {}),
    date: isString(date) ? date : "",
    body,
  };
}

export function isBriefingPriority(value: unknown): value is BriefingPriority {
  return typeof value === "string" && (BRIEFING_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Coerces a raw item-shaped record into a BriefingItem, given an
 * already-resolved accountId and webUrl. Shared by compose_briefing
 * (agent/briefingTool.ts, which resolves the model's account name/address
 * string against connected accounts and builds the webmail deep link from
 * threadId + account before calling this) and parseAgentCard below (which
 * trusts a stored card's `accountId`/`webUrl` fields directly) so the
 * required-field rule and the priority fallback live in exactly one place.
 * Both accountId and webUrl are taken only from the resolved parameters, never
 * read off the raw model-supplied `value` — the model can't be trusted to
 * name our internal account ids or construct a correct provider deep link.
 * Drops anything missing threadId, sender, subject or gist rather than
 * throwing; an unrecognized priority degrades to the least-pressing tier
 * rather than dropping the item.
 */
export function coerceBriefingItem(
  value: unknown,
  accountId: string | undefined,
  webUrl: string | undefined,
): BriefingItem | undefined {
  if (!isRecord(value)) return undefined;
  const {
    threadId,
    messageId,
    sender,
    senderEmail,
    subject,
    gist,
    priority,
    deadline,
    receivedAt,
    draftId,
  } = value;
  if (
    !isNonEmptyString(threadId) ||
    !isNonEmptyString(sender) ||
    !isNonEmptyString(subject) ||
    !isNonEmptyString(gist)
  ) {
    return undefined;
  }
  return {
    threadId,
    ...(isNonEmptyString(messageId) ? { messageId } : {}),
    ...(accountId ? { accountId } : {}),
    sender,
    ...(isNonEmptyString(senderEmail) ? { senderEmail } : {}),
    subject,
    gist,
    priority: isBriefingPriority(priority) ? priority : "fyi",
    ...(isNonEmptyString(deadline) ? { deadline } : {}),
    ...(isNonEmptyString(receivedAt) ? { receivedAt } : {}),
    ...(isNonEmptyString(draftId) ? { draftId } : {}),
    ...(webUrl ? { webUrl } : {}),
  };
}

function parseBriefingItem(value: unknown): BriefingItem | undefined {
  if (!isRecord(value)) return undefined;
  const accountId = isNonEmptyString(value.accountId) ? value.accountId : undefined;
  const webUrl = isNonEmptyString(value.webUrl) ? value.webUrl : undefined;
  return coerceBriefingItem(value, accountId, webUrl);
}

/**
 * Coerces a raw rollup-shaped record into a BriefingRollup, given an
 * already-resolved accountId — same sharing rationale as coerceBriefingItem.
 * `count` is clamped to a non-negative integer rather than trusted verbatim.
 */
export function coerceBriefingRollup(
  value: unknown,
  accountId: string | undefined,
): BriefingRollup | undefined {
  if (!isRecord(value)) return undefined;
  const { label, count, examples } = value;
  if (!isNonEmptyString(label) || typeof count !== "number" || !Number.isFinite(count)) {
    return undefined;
  }
  const exampleList = toStringArray(examples);
  return {
    ...(accountId ? { accountId } : {}),
    label,
    count: Math.max(0, Math.round(count)),
    ...(exampleList ? { examples: exampleList } : {}),
  };
}

function parseBriefingRollup(value: unknown): BriefingRollup | undefined {
  if (!isRecord(value)) return undefined;
  const accountId = isNonEmptyString(value.accountId) ? value.accountId : undefined;
  return coerceBriefingRollup(value, accountId);
}

function parseChoiceOption(value: unknown): ChoiceOption | undefined {
  if (!isRecord(value)) return undefined;
  const { label, detail, reply, ref } = value;
  if (!isNonEmptyString(label)) return undefined;
  const parsedRef = parseEmailRef(ref);
  return {
    label,
    ...(isNonEmptyString(detail) ? { detail } : {}),
    ...(isNonEmptyString(reply) ? { reply } : {}),
    ...(parsedRef ? { ref: parsedRef } : {}),
  };
}

function parseDraftPreview(value: unknown): DraftPreview | undefined {
  if (!isRecord(value)) return undefined;
  const { draftId, threadId, subject, to, cc, bcc, body, webUrl, signatureAppended } = value;
  if (!isString(draftId) || !isString(subject) || !isString(body)) return undefined;
  const ccList = toStringArray(cc);
  const bccList = toStringArray(bcc);
  return {
    draftId,
    ...(isString(threadId) ? { threadId } : {}),
    subject,
    to: toStringArray(to) ?? [],
    ...(ccList ? { cc: ccList } : {}),
    ...(bccList ? { bcc: bccList } : {}),
    body,
    ...(isString(webUrl) ? { webUrl } : {}),
    ...(typeof signatureAppended === "boolean" ? { signatureAppended } : {}),
  };
}

/**
 * Defensive runtime guard for a tool's `details` value. `details` is
 * `unknown` — it may come from our own code (trusted shape, but still
 * crosses an `any` boundary in pi's event stream) or, via
 * `cardFromMcpResult`, from an MCP server we don't control. Coerces what it
 * can, drops anything malformed, and returns `undefined` for anything it
 * doesn't recognize rather than throwing or forwarding a half-built card.
 */
export function parseAgentCard(details: unknown): AgentCard | undefined {
  try {
    if (!isRecord(details)) return undefined;
    const account = parseCardAccount(details.account);

    switch (details.kind) {
      case "email_hits": {
        if (!Array.isArray(details.hits)) return undefined;
        const hits = details.hits.map(parseEmailHit).filter((h): h is EmailHit => h !== undefined);
        return {
          kind: "email_hits",
          ...(account ? { account } : {}),
          ...(isString(details.query) ? { query: details.query } : {}),
          hits,
          ...(typeof details.truncated === "boolean" ? { truncated: details.truncated } : {}),
        };
      }
      case "email_thread": {
        if (!isString(details.threadId) || !Array.isArray(details.messages)) return undefined;
        const messages = details.messages
          .map(parseEmailThreadMessage)
          .filter((m): m is EmailThreadMessage => m !== undefined);
        return {
          kind: "email_thread",
          ...(account ? { account } : {}),
          threadId: details.threadId,
          subject: isString(details.subject) ? details.subject : "",
          messages,
        };
      }
      case "email_draft": {
        const draft = parseDraftPreview(details.draft);
        if (!draft) return undefined;
        return { kind: "email_draft", ...(account ? { account } : {}), draft };
      }
      case "choices": {
        if (!isNonEmptyString(details.question) || !Array.isArray(details.options)) {
          return undefined;
        }
        const options = details.options
          .map(parseChoiceOption)
          .filter((o): o is ChoiceOption => o !== undefined);
        if (options.length === 0) return undefined;
        return { kind: "choices", question: details.question, options };
      }
      case "briefing": {
        // Unlike the other kinds, a briefing carries every account it
        // touched as an array rather than the single optional `account`
        // parsed above — that variable is unused in this arm.
        if (!Array.isArray(details.items)) return undefined;
        const items = details.items
          .map(parseBriefingItem)
          .filter((i): i is BriefingItem => i !== undefined);
        const accountsList = Array.isArray(details.accounts)
          ? details.accounts.map(parseCardAccount).filter((a): a is CardAccount => a !== undefined)
          : undefined;
        const rollups = Array.isArray(details.rollups)
          ? details.rollups
              .map(parseBriefingRollup)
              .filter((r): r is BriefingRollup => r !== undefined)
          : undefined;
        return {
          kind: "briefing",
          ...(isString(details.headline) ? { headline: details.headline } : {}),
          ...(isString(details.periodLabel) ? { periodLabel: details.periodLabel } : {}),
          ...(accountsList && accountsList.length > 0 ? { accounts: accountsList } : {}),
          items,
          ...(rollups && rollups.length > 0 ? { rollups } : {}),
          ...(typeof details.scanned === "number" ? { scanned: details.scanned } : {}),
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Parses a messages.cards JSON blob back into validated cards for the API.
 * Same trust posture as parseAgentCard: the column is our own write, but it
 * round-trips through JSON, so anything malformed is dropped rather than
 * crashing message restore.
 */
export function parseStoredCards(raw: string | null | undefined): MessageCard[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const cards: MessageCard[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || !isString(entry.toolCallId)) continue;
      const card = parseAgentCard(entry.card);
      if (card) cards.push({ toolCallId: entry.toolCallId, card });
    }
    return cards.length > 0 ? cards : undefined;
  } catch {
    return undefined;
  }
}
