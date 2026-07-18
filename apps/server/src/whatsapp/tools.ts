import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { clampLimit, limitParam, numberedList, textResult, tool } from "../agent/toolkit.js";
import { getWhatsAppSocket } from "./session.js";
import {
  chatDisplayName,
  findChatsByName,
  ingestMessages,
  listChats,
  readMessages,
  searchContacts,
  type WaChatRow,
} from "./store.js";

/**
 * The agent's WhatsApp surface, over the local mirror (whatsapp/store.ts).
 * Reads never touch the socket — they work from the mirror even while the
 * link is reconnecting. The one write, whatsapp_send_message, needs the live
 * socket and is built only when the session profile arms it (buildAgent):
 * interactive sessions with the Settings grant, never unattended runs — a
 * WhatsApp send dispatches immediately, there is no draft stage to catch it.
 */

/** How a chat parameter may address a chat, shared phrasing across tools. */
const CHAT_PARAM_DESCRIPTION =
  "The chat: a jid from whatsapp_list_chats, a phone number (digits, with country code), " +
  "or a contact/group name.";

/** Bare digits (an international number with optional +/spaces) → a user jid. */
function jidFromNumber(raw: string): string | null {
  const digits = raw.replace(/[\s+\-()./]/g, "");
  if (!/^\d{6,20}$/.test(digits)) return null;
  return `${digits}@s.whatsapp.net`;
}

interface ChatResolution {
  jid?: string;
  /** Steering text for the model when nothing (or too much) matched. */
  error?: string;
}

/** Resolve a chat parameter to one jid, or to guidance the model can act on. */
function resolveChat(param: string): ChatResolution {
  const trimmed = param.trim();
  if (trimmed.includes("@")) return { jid: trimmed };
  const numberJid = jidFromNumber(trimmed);
  if (numberJid) return { jid: numberJid };

  const matches = findChatsByName(trimmed, 6);
  if (matches.length === 1 && matches[0]) return { jid: matches[0].jid };
  if (matches.length === 0) {
    return {
      error:
        `No chat matches "${trimmed}". Try whatsapp_search_contacts or ` +
        `whatsapp_list_chats to find the right one.`,
    };
  }
  const options = matches.map((m) => `${m.name} (${m.jid})`).join(", ");
  return { error: `"${trimmed}" is ambiguous. Matching chats: ${options}. Pass the jid.` };
}

function chatRowLines(chat: WaChatRow): { head: string; body: string[] } {
  const head = `${chat.name}${chat.isGroup ? " (group)" : ""} — ${chat.jid}`;
  const body: string[] = [];
  if (chat.lastMessageText) {
    const when = chat.lastMessageAt ? ` (${chat.lastMessageAt})` : "";
    const who = chat.lastMessageFromMe ? "me" : chat.name;
    body.push(`Last${when}: ${who}: ${clip(chat.lastMessageText, 120)}`);
  }
  return { head, body };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const listChatsTool = tool({
  name: "whatsapp_list_chats",
  label: "List WhatsApp chats",
  description:
    "List the user's WhatsApp chats, most recently active first, with each chat's jid and " +
    "latest message. Optionally filter by contact/group name or phone number. The mirror " +
    "holds conversations synced since pairing — not the phone's full archive.",
  params: {
    query: Type.Optional(Type.String({ description: "Name or number fragment to filter by." })),
    limit: limitParam(20, "chats"),
  },
  execute: async (params) => {
    const limit = clampLimit(params.limit, 20, 100);
    const chats = listChats({ query: params.query, limit });
    if (chats.length === 0) {
      return textResult(
        params.query?.trim()
          ? `No WhatsApp chats match "${params.query.trim()}".`
          : "No WhatsApp chats are mirrored yet.",
      );
    }
    return textResult(numberedList(chats.map(chatRowLines)));
  },
});

const readMessagesTool = tool({
  name: "whatsapp_read_messages",
  label: "Read WhatsApp messages",
  description:
    "Read one WhatsApp chat's recent messages in chronological order. Media shows as a " +
    "bracketed marker with its caption. Pass `before` (a timestamp from an earlier read) to " +
    "page further back.",
  params: {
    chat: Type.String({ description: CHAT_PARAM_DESCRIPTION }),
    limit: limitParam(30, "messages"),
    before: Type.Optional(
      Type.String({ description: "Only messages before this ISO timestamp (for paging)." }),
    ),
  },
  execute: async (params) => {
    const resolved = resolveChat(params.chat);
    if (!resolved.jid) return textResult(resolved.error ?? "Chat not found.");
    const limit = clampLimit(params.limit, 30, 200);
    const messages = await readMessages(resolved.jid, { limit, before: params.before });
    if (messages.length === 0) {
      return textResult(`No mirrored messages in ${chatDisplayName(resolved.jid)} (yet).`);
    }
    const lines = messages.map((m) => {
      const sender = m.fromMe ? "me" : m.senderName || chatDisplayName(resolved.jid ?? "");
      return `[${m.timestamp}] ${sender}: ${m.text}`;
    });
    return textResult(
      `${chatDisplayName(resolved.jid)} (${resolved.jid}), oldest first:\n${lines.join("\n")}`,
    );
  },
});

const searchContactsTool = tool({
  name: "whatsapp_search_contacts",
  label: "Search WhatsApp contacts",
  description:
    "Find WhatsApp contacts by name or phone number fragment — e.g. to match a lead to " +
    "their WhatsApp chat. Returns names, numbers and jids.",
  params: {
    query: Type.String({ description: "Name or number fragment." }),
    limit: limitParam(15, "contacts"),
  },
  execute: async (params) => {
    const limit = clampLimit(params.limit, 15, 50);
    const contacts = await searchContacts(params.query, limit);
    if (contacts.length === 0) {
      return textResult(`No WhatsApp contacts match "${params.query.trim()}".`);
    }
    return textResult(
      numberedList(
        contacts.map((c) => ({
          head: c.name || c.notify || c.phoneNumber || c.jid,
          body: [
            c.phoneNumber ? `Number: +${c.phoneNumber}` : undefined,
            c.notify && c.name && c.notify !== c.name ? `Push name: ${c.notify}` : undefined,
            `Jid: ${c.jid}`,
          ],
        })),
      ),
    );
  },
});

const sendMessageTool = tool({
  name: "whatsapp_send_message",
  label: "Send WhatsApp message",
  description:
    "Send a WhatsApp text message from the user's personal account. It dispatches " +
    "immediately — there is no draft stage — so state the exact recipient and text and get " +
    "the user's explicit confirmation in this conversation before calling this.",
  params: {
    to: Type.String({ description: CHAT_PARAM_DESCRIPTION }),
    text: Type.String({ description: "The message text to send." }),
  },
  catchToText: true,
  execute: async (params) => {
    const socket = getWhatsAppSocket();
    if (!socket) {
      return textResult(
        "WhatsApp is not connected right now — the message was not sent. " +
          "Ask the user to check the WhatsApp connection in Settings.",
      );
    }
    const resolved = resolveChat(params.to);
    if (!resolved.jid) return textResult(resolved.error ?? "Recipient not found.");
    let jid = resolved.jid;

    // A raw number may not be on WhatsApp (or may map to a different jid) —
    // let the server resolve it before anything is dispatched.
    if (jid.endsWith("@s.whatsapp.net")) {
      const number = jid.split("@")[0] ?? "";
      const match = ((await socket.onWhatsApp(number)) ?? [])[0];
      if (!match?.exists) {
        return textResult(`+${number} is not on WhatsApp — nothing was sent.`);
      }
      jid = match.jid;
    }

    const sent = await socket.sendMessage(jid, { text: params.text });
    // Mirror the sent message so follow-up reads show the full conversation.
    if (sent) ingestMessages([sent]);
    return textResult(`Sent to ${chatDisplayName(jid)} (${jid}).`);
  },
});

/** The read surface — always present while an account is linked. */
const READ_TOOLS: AgentTool[] = [listChatsTool, readMessagesTool, searchContactsTool];

/**
 * The session's WhatsApp tools. `allowSend` comes from the capability
 * profile (agent/capabilities.ts): the Settings grant on interactive
 * sessions, never unattended runs.
 */
export function buildWhatsAppTools(options: { allowSend: boolean }): AgentTool[] {
  return options.allowSend ? [...READ_TOOLS, sendMessageTool] : [...READ_TOOLS];
}
