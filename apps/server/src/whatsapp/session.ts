import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WhatsAppConnection } from "@trailin/shared";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import QRCode from "qrcode";
import { env } from "../env.js";
import { emitServerEvent } from "../events.js";
import { moduleLogger } from "../logger.js";
import {
  clearWhatsAppStore,
  ingestChats,
  ingestContacts,
  ingestHistory,
  ingestMessages,
} from "./store.js";

const log = moduleLogger("whatsapp");

/**
 * Lifecycle of the one WhatsApp Web socket: QR pairing, reconnect with
 * backoff, unlink. Credentials (signal keys + creds.json) persist under
 * env.whatsappAuthPath so the link survives restarts; every store-relevant
 * socket event is forwarded to whatsapp/store.ts. Consumers read status
 * snapshots — the socket itself is only handed out for sends (tools.ts).
 *
 * A Baileys socket is single-use: every reconnect builds a fresh one. The
 * generation counter pins event handlers to the socket they belong to, so a
 * stale socket's trailing events can't corrupt the current state.
 */

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

export interface WhatsAppRuntimeStatus {
  linked: boolean;
  connection: WhatsAppConnection;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  pushName: string | null;
}

interface SessionState {
  socket: WASocket | null;
  connection: WhatsAppConnection;
  /** The raw QR payload currently on offer; the data URL renders async. */
  qr: string | null;
  qrDataUrl: string | null;
  generation: number;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  shuttingDown: boolean;
}

const state: SessionState = {
  socket: null,
  connection: "off",
  qr: null,
  qrDataUrl: null,
  generation: 0,
  reconnectAttempts: 0,
  reconnectTimer: null,
  shuttingDown: false,
};

type LinkedChangeListener = () => void;
const linkedChangeListeners = new Set<LinkedChangeListener>();

/**
 * Runs whenever `linked` flips (pairing completed, account unlinked) — the
 * moments the agent's tool surface changes. A callback registry rather than
 * a session-cache import, so this module stays importable from the agent side
 * without a cycle.
 */
export function onWhatsAppLinkedChange(listener: LinkedChangeListener): void {
  linkedChangeListeners.add(listener);
}

function authDir(): string {
  return resolve(process.cwd(), env.whatsappAuthPath);
}

/** The paired account from creds.json, without needing a live socket. */
function readLinkedMe(): { id?: string; name?: string } | null {
  try {
    const raw = readFileSync(join(authDir(), "creds.json"), "utf8");
    const creds = JSON.parse(raw) as { me?: { id?: string; name?: string } };
    return creds.me ?? null;
  } catch {
    return null;
  }
}

/** Whether a personal account is paired — creds exist and carry an identity. */
export function isWhatsAppLinked(): boolean {
  return readLinkedMe() !== null;
}

/** "4917…" from a me-jid like "4917…:5@s.whatsapp.net"; null when unparsable. */
function phoneNumberOfMeJid(jid: string | undefined): string | null {
  const digits = jid?.split("@")[0]?.split(":")[0] ?? "";
  return /^\d+$/.test(digits) ? digits : null;
}

export function getWhatsAppRuntimeStatus(): WhatsAppRuntimeStatus {
  const me = state.socket?.user ?? readLinkedMe() ?? undefined;
  return {
    linked: isWhatsAppLinked(),
    connection: state.connection,
    qrDataUrl: state.connection === "pairing" ? state.qrDataUrl : null,
    phoneNumber: phoneNumberOfMeJid(me?.id),
    pushName: me?.name?.trim() || null,
  };
}

/** The live socket for sends; null unless the connection is open. */
export function getWhatsAppSocket(): WASocket | null {
  return state.connection === "open" ? state.socket : null;
}

let lastNotifiedLinked: boolean | null = null;

/** Broadcast a state change: UI refetch always, linked-flip listeners when it flipped. */
function notifyStatusChanged(): void {
  emitServerEvent("whatsapp");
  const linked = isWhatsAppLinked();
  if (lastNotifiedLinked !== null && linked !== lastNotifiedLinked) {
    for (const listener of linkedChangeListeners) listener();
  }
  lastNotifiedLinked = linked;
}

function setConnection(connection: WhatsAppConnection): void {
  if (state.connection === connection) return;
  state.connection = connection;
  if (connection !== "pairing") {
    state.qr = null;
    state.qrDataUrl = null;
  }
  log.info({ connection }, "WhatsApp connection state changed");
  notifyStatusChanged();
}

function renderQr(qr: string): void {
  state.qr = qr;
  state.qrDataUrl = null;
  QRCode.toDataURL(qr, { errorCorrectionLevel: "M", margin: 1, scale: 6 })
    .then((dataUrl) => {
      // Only publish if this QR is still the one on offer (they rotate ~20s).
      if (state.qr !== qr) return;
      state.qrDataUrl = dataUrl;
      notifyStatusChanged();
    })
    .catch((err: unknown) => log.warn({ err }, "rendering the pairing QR failed"));
}

function scheduleReconnect(): void {
  if (state.reconnectTimer || state.shuttingDown) return;
  const delay =
    RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)] ??
    60_000;
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect().catch((err: unknown) => {
      log.warn({ err }, "WhatsApp reconnect failed");
      scheduleReconnect();
    });
  }, delay);
  state.reconnectTimer.unref();
  log.debug({ delay, attempt: state.reconnectAttempts }, "WhatsApp reconnect scheduled");
}

/** statusCode of a Baileys close error (a Boom), read structurally. */
function disconnectStatusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: number } } | undefined)?.output;
  return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

function handleClose(generation: number, error: unknown): void {
  if (generation !== state.generation) return;
  state.socket = null;
  const statusCode = disconnectStatusCode(error);

  if (statusCode === DisconnectReason.loggedOut) {
    // Unlinked from the phone: the credentials are dead — same cleanup as a
    // local unlink, minus the remote logout that already happened.
    log.info("WhatsApp logged out remotely — clearing the link");
    void wipeLink();
    return;
  }
  if (state.shuttingDown) {
    setConnection("off");
    return;
  }
  if (!isWhatsAppLinked()) {
    // Pairing ended without a scan (QR timeout) or was aborted — back to off;
    // the user restarts pairing from Settings rather than this looping
    // against WhatsApp's servers.
    log.info({ statusCode }, "WhatsApp pairing ended without a link");
    setConnection("off");
    return;
  }
  // A paired account reconnects: immediately after the post-pairing restart
  // WhatsApp requires (515), with backoff for everything else.
  setConnection("connecting");
  if (statusCode === DisconnectReason.restartRequired) {
    connect().catch((err: unknown) => {
      log.warn({ err }, "WhatsApp post-pairing restart failed");
      scheduleReconnect();
    });
  } else {
    log.info({ statusCode }, "WhatsApp connection closed — reconnecting");
    scheduleReconnect();
  }
}

async function connect(): Promise<void> {
  if (state.socket || state.shuttingDown) return;
  const generation = ++state.generation;
  const wasLinked = isWhatsAppLinked();
  setConnection(wasLinked ? "connecting" : "pairing");

  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir());
  // Baileys logs a lot at info; keep only its warnings, under our logger.
  const socketLogger = log.child({ lib: "baileys" }, { level: "warn" });
  const socket = makeWASocket({
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, socketLogger),
    },
    logger: socketLogger,
    browser: Browsers.macOS("Trailin"),
    // The recent-history sync is plenty for the mirror; a full-history sync
    // floods the store for months-old chats nobody asks about.
    syncFullHistory: false,
    // Never present as online: that would suppress notifications on the
    // user's phone whenever the server is running.
    markOnlineOnConnect: false,
  });
  if (generation !== state.generation) {
    // A logout/shutdown raced this connect; discard the fresh socket.
    void socket.end(undefined);
    return;
  }
  state.socket = socket;

  socket.ev.on("creds.update", () => {
    void saveCreds();
  });
  socket.ev.on("connection.update", (update) => {
    if (generation !== state.generation) return;
    if (update.qr) {
      setConnection("pairing");
      renderQr(update.qr);
    }
    if (update.connection === "open") {
      state.reconnectAttempts = 0;
      setConnection("open");
    } else if (update.connection === "close") {
      handleClose(generation, update.lastDisconnect?.error);
    }
  });

  // Store ingestion. Failures must never take the socket down — the mirror
  // is best-effort by design.
  const guarded = (what: string, run: () => void) => {
    try {
      run();
    } catch (err) {
      log.warn({ err }, `ingesting WhatsApp ${what} failed`);
    }
  };
  socket.ev.on("messaging-history.set", (payload) => {
    if (generation !== state.generation) return;
    guarded("history", () => ingestHistory(payload));
  });
  socket.ev.on("messages.upsert", ({ messages }) => {
    if (generation !== state.generation) return;
    guarded("messages", () => ingestMessages(messages));
  });
  socket.ev.on("contacts.upsert", (contacts) => {
    if (generation !== state.generation) return;
    guarded("contacts", () => ingestContacts(contacts));
  });
  socket.ev.on("contacts.update", (contacts) => {
    if (generation !== state.generation) return;
    guarded("contacts", () => ingestContacts(contacts));
  });
  socket.ev.on("chats.upsert", (chats) => {
    if (generation !== state.generation) return;
    guarded("chats", () => ingestChats(chats));
  });
}

/** Boot: reconnect a paired account. Without credentials this does nothing. */
export function startWhatsApp(): void {
  lastNotifiedLinked = isWhatsAppLinked();
  if (!lastNotifiedLinked) return;
  connect().catch((err: unknown) => {
    log.warn({ err }, "WhatsApp connect on boot failed");
    scheduleReconnect();
  });
}

/** Settings "connect": open a socket so the pairing QR starts flowing. */
export async function beginWhatsAppPairing(): Promise<void> {
  state.shuttingDown = false;
  await connect();
}

/** Tear the current socket down and forget the link locally. */
async function wipeLink(): Promise<void> {
  state.generation++;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.reconnectAttempts = 0;
  const socket = state.socket;
  state.socket = null;
  if (socket) await socket.end(undefined).catch(() => {});
  try {
    rmSync(authDir(), { recursive: true, force: true });
  } catch (err) {
    log.warn({ err }, "removing the WhatsApp auth folder failed");
  }
  await clearWhatsAppStore().catch((err: unknown) => {
    log.warn({ err }, "clearing the WhatsApp mirror failed");
  });
  setConnection("off");
  // setConnection dedupes repeats — make sure the linked flip always lands.
  notifyStatusChanged();
}

/**
 * Unlink: sign the device out remotely (best-effort), drop the credentials
 * and wipe the mirror. The account and its chats on the phone are untouched.
 */
export async function unlinkWhatsApp(): Promise<void> {
  const socket = state.socket;
  if (socket && state.connection === "open") {
    await socket.logout().catch((err: unknown) => {
      log.warn({ err }, "remote WhatsApp logout failed — unlinking locally anyway");
    });
  }
  await wipeLink();
}

/** Shutdown: close the socket, keep credentials and mirror for the next boot. */
export async function stopWhatsApp(): Promise<void> {
  state.shuttingDown = true;
  state.generation++;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const socket = state.socket;
  state.socket = null;
  if (socket) await socket.end(undefined).catch(() => {});
  state.connection = "off";
}
