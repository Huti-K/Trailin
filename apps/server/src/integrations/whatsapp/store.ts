import { and, desc, eq, lt, or } from "drizzle-orm";
import { db, lazyStatement, lazyTransaction, schema } from "../../db/index.js";
import { likeContains, likePattern } from "../../db/like.js";

/**
 * The WhatsApp mirror: chats, contacts and messages accumulated from Baileys
 * events. The protocol pushes state instead of answering queries, so this store
 * is the only thing the read tools have: anything not ingested here is
 * unreachable later.
 *
 * Inputs are structural subsets of Baileys' event payloads, navigated
 * defensively (SDK output is untrusted input): rows are written only when a jid
 * and a usable text resolve. Media never lands here: a media message is kept as
 * a bracketed marker ("[image] caption"), and unrenderable protocol events
 * (reactions, key distribution) are skipped.
 */

/** Baileys timestamps arrive as seconds: number, numeric string, or protobuf Long. */
type WaTimestamp = number | string | { toNumber(): number } | null | undefined;

export interface WaContactInput {
  id?: string | null;
  name?: string | null;
  notify?: string | null;
  /** The contact's phone-number jid, when the id is a LID. */
  phoneNumber?: string | null;
}

export interface WaChatInput {
  id?: string | null;
  name?: string | null;
  conversationTimestamp?: WaTimestamp;
}

export interface WaMessageInput {
  key?: {
    remoteJid?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
  } | null;
  pushName?: string | null;
  messageTimestamp?: WaTimestamp;
  message?: unknown;
}

/** Chats that are not conversations: statuses, channels, broadcast lists. */
function isIgnoredJid(jid: string): boolean {
  return jid.endsWith("@broadcast") || jid.endsWith("@newsletter");
}

function phoneNumberOf(jid: string | null | undefined): string {
  if (!jid?.endsWith("@s.whatsapp.net")) return "";
  const local = jid.split("@")[0] ?? "";
  const digits = local.split(":")[0] ?? "";
  return /^\d+$/.test(digits) ? digits : "";
}

function toEpochMs(value: WaTimestamp): number | null {
  let seconds: number;
  if (typeof value === "number") seconds = value;
  else if (typeof value === "string") seconds = Number(value);
  else if (value && typeof value.toNumber === "function") seconds = value.toNumber();
  else return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

function toIso(value: WaTimestamp): string | null {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** The content wrappers WhatsApp nests real messages inside (ephemeral, view-once, …). */
const WRAPPER_KEYS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
] as const;

type Content = Record<string, unknown>;

function asRecord(value: unknown): Content | null {
  return typeof value === "object" && value !== null ? (value as Content) : null;
}

function stringField(content: Content | null, key: string): string {
  const value = content?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A message's agent-facing text: real text as-is, media as a bracketed marker
 * (plus caption/filename), null for protocol events that render as nothing
 * (reactions, edits, key distribution); callers skip those rows.
 */
export function messageTextOf(message: unknown): string | null {
  let content = asRecord(message);
  if (!content) return null;
  for (let depth = 0; depth < 3; depth++) {
    const wrapperKey = WRAPPER_KEYS.find((key) => asRecord(content?.[key]));
    if (!wrapperKey) break;
    const inner = asRecord(asRecord(content?.[wrapperKey])?.message);
    if (!inner) break;
    content = inner;
  }

  const conversation = stringField(content, "conversation");
  if (conversation) return conversation;
  const extended = stringField(asRecord(content.extendedTextMessage), "text");
  if (extended) return extended;

  const withMarker = (marker: string, detail: string): string =>
    detail ? `${marker} ${detail}` : marker;
  const image = asRecord(content.imageMessage);
  if (image) return withMarker("[image]", stringField(image, "caption"));
  const video = asRecord(content.videoMessage);
  if (video) return withMarker("[video]", stringField(video, "caption"));
  const document = asRecord(content.documentMessage);
  if (document) {
    const label = stringField(document, "caption") || stringField(document, "fileName");
    return withMarker("[document]", label);
  }
  const audio = asRecord(content.audioMessage);
  if (audio) return audio.ptt === true ? "[voice message]" : "[audio]";
  if (asRecord(content.stickerMessage)) return "[sticker]";
  const location = asRecord(content.locationMessage) ?? asRecord(content.liveLocationMessage);
  if (location) return withMarker("[location]", stringField(location, "name"));
  const contact = asRecord(content.contactMessage);
  if (contact) return withMarker("[contact]", stringField(contact, "displayName"));
  if (asRecord(content.contactsArrayMessage)) return "[contacts]";
  if (asRecord(content.pollCreationMessage) ?? asRecord(content.pollCreationMessageV3)) {
    return "[poll]";
  }
  return null;
}

/** Keep only the newest rows of one chat: the mirror is a working set, not an archive. */
const MESSAGES_KEPT_PER_CHAT = 500;

const upsertContactStmt = lazyStatement(`
  INSERT INTO wa_contacts (jid, name, notify, phone_number, updated_at)
  VALUES (@jid, @name, @notify, @phoneNumber, @updatedAt)
  ON CONFLICT(jid) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE wa_contacts.name END,
    notify = CASE WHEN excluded.notify != '' THEN excluded.notify ELSE wa_contacts.notify END,
    phone_number = CASE WHEN excluded.phone_number != '' THEN excluded.phone_number
                        ELSE wa_contacts.phone_number END,
    updated_at = excluded.updated_at
`);

const upsertChatStmt = lazyStatement(`
  INSERT INTO wa_chats (jid, name, last_message_at, updated_at)
  VALUES (@jid, @name, @lastMessageAt, @updatedAt)
  ON CONFLICT(jid) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE wa_chats.name END,
    last_message_at = CASE
      WHEN excluded.last_message_at IS NULL THEN wa_chats.last_message_at
      WHEN wa_chats.last_message_at IS NULL THEN excluded.last_message_at
      WHEN excluded.last_message_at > wa_chats.last_message_at THEN excluded.last_message_at
      ELSE wa_chats.last_message_at END,
    updated_at = excluded.updated_at
`);

const insertMessageStmt = lazyStatement(`
  INSERT INTO wa_messages (chat_jid, id, sender_jid, sender_name, from_me, text, timestamp)
  VALUES (@chatJid, @id, @senderJid, @senderName, @fromMe, @text, @timestamp)
  ON CONFLICT(chat_jid, id) DO NOTHING
`);

const trimChatStmt = lazyStatement(`
  DELETE FROM wa_messages
   WHERE chat_jid = @chatJid
     AND rowid NOT IN (
       SELECT rowid FROM wa_messages WHERE chat_jid = @chatJid
        ORDER BY timestamp DESC, rowid DESC LIMIT ${MESSAGES_KEPT_PER_CHAT}
     )
`);

function writeContacts(contacts: WaContactInput[], updatedAt: string): void {
  for (const contact of contacts) {
    const jid = contact.id?.trim();
    if (!jid || isIgnoredJid(jid)) continue;
    upsertContactStmt().run({
      jid,
      name: contact.name?.trim() ?? "",
      notify: contact.notify?.trim() ?? "",
      phoneNumber: phoneNumberOf(contact.phoneNumber) || phoneNumberOf(jid),
      updatedAt,
    });
  }
}

function writeChats(chats: WaChatInput[], updatedAt: string): void {
  for (const chat of chats) {
    const jid = chat.id?.trim();
    if (!jid || isIgnoredJid(jid)) continue;
    upsertChatStmt().run({
      jid,
      name: chat.name?.trim() ?? "",
      lastMessageAt: toIso(chat.conversationTimestamp),
      updatedAt,
    });
  }
}

function writeMessages(messages: WaMessageInput[], updatedAt: string): void {
  const touchedChats = new Set<string>();
  for (const message of messages) {
    const chatJid = message.key?.remoteJid?.trim();
    const id = message.key?.id?.trim();
    if (!chatJid || !id || isIgnoredJid(chatJid)) continue;
    const text = messageTextOf(message.message);
    if (text === null) continue;
    const timestamp = toIso(message.messageTimestamp);
    if (!timestamp) continue;
    const fromMe = message.key?.fromMe === true;
    const senderJid = fromMe ? "" : (message.key?.participant?.trim() ?? "");
    const senderName = fromMe ? "" : (message.pushName?.trim() ?? "");

    insertMessageStmt().run({
      chatJid,
      id,
      senderJid,
      senderName,
      fromMe: fromMe ? 1 : 0,
      text,
      timestamp,
    });
    touchedChats.add(chatJid);
    upsertChatStmt().run({ jid: chatJid, name: "", lastMessageAt: timestamp, updatedAt });
    // Direct-chat senders carry their push name on the message: cheap name
    // coverage for people not in the address book.
    if (!fromMe && senderName && !chatJid.endsWith("@g.us") && !senderJid) {
      upsertContactStmt().run({
        jid: chatJid,
        name: "",
        notify: senderName,
        phoneNumber: phoneNumberOf(chatJid),
        updatedAt,
      });
    }
  }
  for (const chatJid of touchedChats) trimChatStmt().run({ chatJid });
}

const runHistoryIngest = lazyTransaction(
  (chats: WaChatInput[], contacts: WaContactInput[], messages: WaMessageInput[]) => {
    const now = new Date().toISOString();
    writeContacts(contacts, now);
    writeChats(chats, now);
    writeMessages(messages, now);
  },
);

export function ingestHistory(payload: {
  chats?: WaChatInput[];
  contacts?: WaContactInput[];
  messages?: WaMessageInput[];
}): void {
  runHistoryIngest(payload.chats ?? [], payload.contacts ?? [], payload.messages ?? []);
}

const runMessageIngest = lazyTransaction((messages: WaMessageInput[]) => {
  writeMessages(messages, new Date().toISOString());
});

export function ingestMessages(messages: WaMessageInput[]): void {
  if (messages.length > 0) runMessageIngest(messages);
}

const runContactsIngest = lazyTransaction((contacts: WaContactInput[]) => {
  writeContacts(contacts, new Date().toISOString());
});

export function ingestContacts(contacts: WaContactInput[]): void {
  if (contacts.length > 0) runContactsIngest(contacts);
}

const runChatsIngest = lazyTransaction((chats: WaChatInput[]) => {
  writeChats(chats, new Date().toISOString());
});

export function ingestChats(chats: WaChatInput[]): void {
  if (chats.length > 0) runChatsIngest(chats);
}

/** Unlink wipe: the mirror exists only alongside a paired account. */
export async function clearWhatsAppStore(): Promise<void> {
  await db.delete(schema.waMessages);
  await db.delete(schema.waChats);
  await db.delete(schema.waContacts);
}

/** A chat's display name: its own name (groups), else the contact's, else the number. */
const CHAT_NAME_SQL = `COALESCE(
  NULLIF(c.name, ''), NULLIF(ct.name, ''), NULLIF(ct.notify, ''), NULLIF(ct.phone_number, ''),
  c.jid
)`;

export interface WaChatRow {
  jid: string;
  name: string;
  isGroup: boolean;
  lastMessageAt: string | null;
  lastMessageText: string | null;
  lastMessageFromMe: boolean;
}

const listChatsStmt = lazyStatement(`
  SELECT c.jid AS jid, ${CHAT_NAME_SQL} AS name, c.last_message_at AS lastMessageAt,
         (SELECT m.text FROM wa_messages m WHERE m.chat_jid = c.jid
           ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS lastMessageText,
         (SELECT m.from_me FROM wa_messages m WHERE m.chat_jid = c.jid
           ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS lastMessageFromMe
    FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.jid = c.jid
   WHERE @query = '' OR ${CHAT_NAME_SQL} LIKE @pattern ESCAPE '\\' OR c.jid LIKE @pattern ESCAPE '\\'
   ORDER BY c.last_message_at IS NULL, c.last_message_at DESC
   LIMIT @limit
`);

export function listChats(options: { query?: string; limit: number }): WaChatRow[] {
  const query = options.query?.trim() ?? "";
  const rows = listChatsStmt().all({
    query,
    pattern: likeContains(query),
    limit: options.limit,
  }) as Array<{
    jid: string;
    name: string;
    lastMessageAt: string | null;
    lastMessageText: string | null;
    lastMessageFromMe: number | null;
  }>;
  return rows.map((row) => ({
    jid: row.jid,
    name: row.name,
    isGroup: row.jid.endsWith("@g.us"),
    lastMessageAt: row.lastMessageAt,
    lastMessageText: row.lastMessageText,
    lastMessageFromMe: row.lastMessageFromMe === 1,
  }));
}

export interface WaMessageRow {
  id: string;
  senderJid: string;
  senderName: string;
  fromMe: boolean;
  text: string;
  timestamp: string;
}

/** One chat's messages in chronological order; the newest window when capped. */
export async function readMessages(
  chatJid: string,
  options: { limit: number; before?: string },
): Promise<WaMessageRow[]> {
  const scope = eq(schema.waMessages.chatJid, chatJid);
  const rows = await db
    .select()
    .from(schema.waMessages)
    .where(options.before ? and(scope, lt(schema.waMessages.timestamp, options.before)) : scope)
    .orderBy(desc(schema.waMessages.timestamp), desc(schema.waMessages.id))
    .limit(options.limit);
  return rows.reverse().map((row) => ({
    id: row.id,
    senderJid: row.senderJid,
    senderName: row.senderName,
    fromMe: row.fromMe === 1,
    text: row.text,
    timestamp: row.timestamp,
  }));
}

export interface WaContactRow {
  jid: string;
  name: string;
  notify: string;
  phoneNumber: string;
}

export async function searchContacts(query: string, limit: number): Promise<WaContactRow[]> {
  const pattern = likeContains(query.trim());
  const rows = await db
    .select()
    .from(schema.waContacts)
    .where(
      or(
        likePattern(schema.waContacts.name, pattern),
        likePattern(schema.waContacts.notify, pattern),
        likePattern(schema.waContacts.phoneNumber, pattern),
      ),
    )
    .orderBy(schema.waContacts.name, schema.waContacts.notify)
    .limit(limit);
  return rows.map((row) => ({
    jid: row.jid,
    name: row.name,
    notify: row.notify,
    phoneNumber: row.phoneNumber,
  }));
}

export function findChatsByName(query: string, limit: number): WaChatRow[] {
  return listChats({ query, limit });
}

const chatNameStmt = lazyStatement(`
  SELECT ${CHAT_NAME_SQL} AS name
    FROM wa_chats c LEFT JOIN wa_contacts ct ON ct.jid = c.jid
   WHERE c.jid = @jid
`);

export function chatDisplayName(jid: string): string {
  const row = chatNameStmt().get({ jid }) as { name: string } | undefined;
  return row?.name ?? (phoneNumberOf(jid) || jid);
}
