import * as React from "react";
import {
  Check,
  Copy,
  Loader2,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AccountColor,
  AgentCard,
  ChatStreamEvent,
  ChatToolCall,
  Conversation,
} from "@trailin/shared";
import { api, streamChat } from "@/lib/api";
import { AgentCardView } from "@/features/chat/cards";
import { SHOWCASE_TURNS } from "@/features/chat/cards/samples";
import { Button } from "@/components/ui/button";
import { LoadingRow } from "@/components/ui/feedback";
import { EmptyState } from "@/components/ui/empty-state";
import { Markdown } from "@/components/ui/markdown";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { dateTimeLabel } from "@/lib/dates";
import { toast } from "@/lib/toast";
import { useServerEvents } from "@/lib/serverEvents";
import { cn, errorMessage } from "@/lib/utils";

/** Same-device continuity: the conversation to restore on the next load. */
const LAST_CONVERSATION_KEY = "trailin-last-conversation";

/** Renders one of every agent card locally. Never reaches the agent or the DB. */
const SHOWCASE_COMMAND = "/showcase";
const SYSTEM_PROMPT_COMMAND = "/sys";

/** First page size for the history rail; "Load more" fetches in the same increments. */
const CONVERSATIONS_PAGE_SIZE = 50;

/** How far back a conversation's `createdAt` (local time) groups it in the rail. */
type RecencyGroup = "today" | "yesterday" | "week" | "earlier";

const RECENCY_ORDER: RecencyGroup[] = ["today", "yesterday", "week", "earlier"];
// `as const` keeps these as literal keys so t() can type-check them below.
const RECENCY_LABEL_KEY = {
  today: "chat.groupToday",
  yesterday: "chat.groupYesterday",
  week: "chat.groupThisWeek",
  earlier: "chat.groupEarlier",
} as const satisfies Record<RecencyGroup, string>;

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function recencyGroup(createdAt: string, now: Date): RecencyGroup {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(new Date(createdAt)).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "week";
  return "earlier";
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: ChatToolCall[];
  /** Structured tool results, keyed by tool call so a retried tool replaces its card. */
  cards: { toolCallId: string; card: AgentCard }[];
  streaming: boolean;
  thinking?: boolean;
  error?: string;
  /** Local-only /sys result. */
  systemPrompt?: string;
}

interface ActiveRun {
  conversationId?: string;
  messages: DisplayMessage[];
}

export function ChatPanel({
  historyOpen,
  setHistoryOpen,
  layout = "panel",
  onConversationChange,
}: {
  historyOpen: boolean;
  setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** "panel" is the floating side-panel; "page" is the full-page Chat tab (history lives in an external rail). */
  layout?: "panel" | "page";
  /** Lets the host mirror the active conversation (e.g. to highlight it in the Chat tab's history rail). */
  onConversationChange?: (id: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = React.useState<DisplayMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [restoring, setRestoring] = React.useState(true);
  const [conversationId, setConversationId] = React.useState<string | undefined>();
  // A message queued by "trailin:send-chat" — sent by the effect below once the
  // panel is idle, so it never races the conversation reset or a streaming turn.
  const [pendingSend, setPendingSend] = React.useState<string | null>(null);
  // Tints each card's account chip. Cosmetic, so a failed load is not surfaced.
  const [accountColors, setAccountColors] = React.useState<AccountColor[]>([]);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const activeConversationRef = React.useRef<string | undefined>(undefined);
  const messagesRef = React.useRef<DisplayMessage[]>([]);
  const activeRunRef = React.useRef<ActiveRun | null>(null);
  const runByConversationRef = React.useRef(new Map<string, ActiveRun>());
  const messageCacheRef = React.useRef(new Map<string, DisplayMessage[]>());

  React.useEffect(() => {
    let cancelled = false;
    api
      .accountColors()
      .then(({ colors }) => {
        if (!cancelled) setAccountColors(colors);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Pick up where this device left off. Text, cards, tool activity and turn
  // errors are persisted together and restored here.
  React.useEffect(() => {
    const savedId = localStorage.getItem(LAST_CONVERSATION_KEY);
    if (!savedId) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    api
      .conversationMessages(savedId)
      .then((msgs) => {
        if (cancelled || msgs.length === 0) return;
        const restored: DisplayMessage[] = msgs.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls ?? [],
          cards: m.cards ?? [],
          streaming: false,
          error: m.error,
        }));
        activeConversationRef.current = savedId;
        messagesRef.current = restored;
        messageCacheRef.current.set(savedId, restored);
        setMessages(restored);
        setConversationId(savedId);
      })
      .catch((err) => {
        // Unreachable or gone — start fresh, but don't make the failure silent.
        toast.error(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Keep the host in sync with the open conversation (Chat tab highlights it).
  React.useEffect(() => {
    onConversationChange?.(conversationId);
  }, [conversationId, onConversationChange]);

  // Grow the textarea with its content, up to the CSS max-height cap (then it
  // scrolls internally). Empty is left to the CSS min-height instead of measured
  // via scrollHeight — Chrome/Firefox size that against the wrapped placeholder
  // text, not the (empty) value, which puffed the box up at rest.
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const updateRunAssistant = (
    run: ActiveRun,
    updater: (message: DisplayMessage) => DisplayMessage,
  ) => {
    const next = [...run.messages];
    const last = next[next.length - 1];
    if (last && last.role === "assistant" && last.streaming) {
      next[next.length - 1] = updater(last);
    }
    run.messages = next;
    if (run.conversationId) messageCacheRef.current.set(run.conversationId, next);
    if (
      activeRunRef.current === run ||
      (run.conversationId !== undefined && activeConversationRef.current === run.conversationId)
    ) {
      messagesRef.current = next;
      setMessages(next);
    }
  };

  const handleRunEvent = (run: ActiveRun, event: ChatStreamEvent) => {
    switch (event.type) {
      case "conversation":
        run.conversationId = event.conversationId;
        runByConversationRef.current.set(event.conversationId, run);
        messageCacheRef.current.set(event.conversationId, run.messages);
        if (activeRunRef.current === run) {
          activeConversationRef.current = event.conversationId;
          setConversationId(event.conversationId);
          localStorage.setItem(LAST_CONVERSATION_KEY, event.conversationId);
        }
        // The conversation row has already been committed when this stream event
        // arrives. Invalidate same-tab history directly rather than relying only
        // on the separate SSE connection, which may still be connecting.
        window.dispatchEvent(new CustomEvent("trailin:conversations-changed"));
        break;
      case "thinking":
        updateRunAssistant(run, (m) => ({ ...m, thinking: true }));
        break;
      case "text_delta":
        updateRunAssistant(run, (m) => ({ ...m, content: m.content + event.delta, thinking: false }));
        break;
      case "tool_start":
        updateRunAssistant(run, (m) => ({
          ...m,
          thinking: false,
          toolCalls: [
            ...m.toolCalls,
            {
              id: event.toolCallId,
              name: event.toolName,
              isError: false,
              done: false,
              parameters: event.parameters,
              contentOffset: event.contentOffset,
            },
          ],
        }));
        break;
      case "tool_update":
        updateRunAssistant(run, (m) => ({
          ...m,
          toolCalls: m.toolCalls.map((call) =>
            call.id === event.toolCallId ? { ...call, detail: event.detail } : call,
          ),
        }));
        break;
      case "tool_end":
        updateRunAssistant(run, (m) => ({
          ...m,
          toolCalls: m.toolCalls.map((call) =>
            call.id === event.toolCallId
              ? { ...call, done: true, isError: event.isError, result: event.result }
              : call,
          ),
        }));
        break;
      case "card":
        updateRunAssistant(run, (m) => ({
          ...m,
          thinking: false,
          cards: [
            ...m.cards.filter((c) => c.toolCallId !== event.toolCallId),
            { toolCallId: event.toolCallId, card: event.card },
          ],
        }));
        break;
      case "done":
        updateRunAssistant(run, (m) => ({
          ...m,
          content: event.text || m.content,
          streaming: false,
          thinking: false,
        }));
        break;
      case "error":
        toast.error(event.message);
        updateRunAssistant(run, (m) => ({
          ...m,
          error: event.message,
          streaming: false,
          thinking: false,
        }));
        break;
    }
  };

  /** Answers `/showcase` client-side: one sample turn per thing the assistant can render. */
  const showcase = (message: string) => {
    setMessages((prev) => {
      const next: DisplayMessage[] = [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        toolCalls: [],
        cards: [],
        streaming: false,
      },
      ...SHOWCASE_TURNS.map((turn, turnIndex) => ({
        id: crypto.randomUUID(),
        role: "assistant" as const,
        content: turn.contentKey ? String(t(turn.contentKey as any)) : (turn.content ?? ""),
        toolCalls: (turn.toolCalls ?? []).map((call, i) => ({
          ...call,
          id: `showcase-tool-${turnIndex}-${i}`,
        })),
        cards: (turn.cards ?? []).map((card, i) => ({
          toolCallId: `showcase-${turnIndex}-${i}`,
          card,
        })),
        streaming: turn.thinking ?? false,
        thinking: turn.thinking,
      })),
      ];
      messagesRef.current = next;
      return next;
    });
  };

  const showSystemPrompt = async (message: string) => {
    setBusy(true);
    const userMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      toolCalls: [],
      cards: [],
      streaming: false,
    };
    const loadingMessage: DisplayMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: [],
      cards: [],
      streaming: true,
      thinking: true,
    };
    const next = [...messagesRef.current, userMessage, loadingMessage];
    messagesRef.current = next;
    setMessages(next);
    try {
      const { prompt } = await api.systemPrompt();
      const done = next.map((item) =>
        item.id === loadingMessage.id
          ? { ...item, streaming: false, thinking: false, systemPrompt: prompt }
          : item,
      );
      messagesRef.current = done;
      setMessages(done);
    } catch (err) {
      const messageText = errorMessage(err);
      toast.error(messageText);
      const failed = next.map((item) =>
        item.id === loadingMessage.id
          ? { ...item, streaming: false, thinking: false, error: messageText }
          : item,
      );
      messagesRef.current = failed;
      setMessages(failed);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  /** Sends a message in the open conversation (or starts one server-side). */
  const sendText = async (message: string) => {
    if (!message || busy) return;
    setHistoryOpen(false);

    if (message.toLowerCase() === SHOWCASE_COMMAND) {
      showcase(message);
      return;
    }
    if (message.toLowerCase() === SYSTEM_PROMPT_COMMAND) {
      await showSystemPrompt(message);
      return;
    }

    setBusy(true);
    const next: DisplayMessage[] = [
      ...messagesRef.current,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        toolCalls: [],
        cards: [],
        streaming: false,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        cards: [],
        streaming: true,
      },
    ];
    const run: ActiveRun = { conversationId: activeConversationRef.current, messages: next };
    activeRunRef.current = run;
    if (run.conversationId) {
      runByConversationRef.current.set(run.conversationId, run);
      messageCacheRef.current.set(run.conversationId, next);
    }
    messagesRef.current = next;
    setMessages(next);

    try {
      await streamChat(
        { conversationId: activeConversationRef.current, message },
        (event) => handleRunEvent(run, event),
      );
    } catch (err) {
      const messageText = errorMessage(err);
      toast.error(messageText);
      updateRunAssistant(run, (m) => ({
        ...m,
        error: messageText,
        streaming: false,
        thinking: false,
      }));
    } finally {
      if (run.conversationId) runByConversationRef.current.delete(run.conversationId);
      if (activeRunRef.current === run) {
        activeRunRef.current = null;
        setBusy(false);
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    await sendText(message);
  };

  const openConversation = async (id: string) => {
    activeConversationRef.current = id;
    setConversationId(id);
    localStorage.setItem(LAST_CONVERSATION_KEY, id);
    setHistoryOpen(false);
    const liveRun = runByConversationRef.current.get(id) ?? null;
    activeRunRef.current = liveRun;
    setBusy(Boolean(liveRun));
    const cached = messageCacheRef.current.get(id);
    if (cached) {
      messagesRef.current = cached;
      setMessages(cached);
      textareaRef.current?.focus();
      return;
    }
    try {
      const msgs = await api.conversationMessages(id);
      if (activeConversationRef.current !== id) return;
      const restored: DisplayMessage[] = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls ?? [],
        cards: m.cards ?? [],
        streaming: false,
        error: m.error,
      }));
      messageCacheRef.current.set(id, restored);
      messagesRef.current = restored;
      setMessages(restored);
      // Opening a conversation means continuing it — put the caret where the
      // user's next message goes (e.g. the Drafts page's refine jump).
      textareaRef.current?.focus();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const newConversation = React.useCallback(() => {
    activeConversationRef.current = undefined;
    activeRunRef.current = null;
    setBusy(false);
    messagesRef.current = [];
    setConversationId(undefined);
    setMessages([]);
    setHistoryOpen(false);
    localStorage.removeItem(LAST_CONVERSATION_KEY);
  }, [setHistoryOpen]);

  // Deferred one render on purpose: the event handler resets the conversation,
  // and sending in the same tick would stream into the closed-over old one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!pendingSend || busy || restoring) return;
    setPendingSend(null);
    void sendText(pendingSend);
  });

  React.useEffect(() => {
    const handleOpenChat = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      void openConversation(id);
    };
    // Starts a fresh conversation with the composer pre-filled (not sent) —
    // how other panels hand a suggested question to the chat (dispatch
    // together with "trailin:show-chat" so the panel is actually visible).
    const handlePrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      newConversation();
      setInput(text);
      textareaRef.current?.focus();
    };
    // Like prefill, but sends immediately — for actions where the composed
    // message is complete as-is (e.g. the digest's "draft a reply" buttons).
    const handleSendEvent = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      newConversation();
      setPendingSend(text);
    };
    window.addEventListener("trailin:new-chat", newConversation);
    window.addEventListener("trailin:open-chat", handleOpenChat);
    window.addEventListener("trailin:prefill-chat", handlePrefill);
    window.addEventListener("trailin:send-chat", handleSendEvent);
    return () => {
      window.removeEventListener("trailin:new-chat", newConversation);
      window.removeEventListener("trailin:open-chat", handleOpenChat);
      window.removeEventListener("trailin:prefill-chat", handlePrefill);
      window.removeEventListener("trailin:send-chat", handleSendEvent);
    };
  }, [newConversation]);

  const isPage = layout === "page";

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden">

      <div className="min-h-0 flex-1 overflow-y-auto scroll-stable">
        {/* In page mode the history rail is external, so the internal toggle is inert. */}
        {!isPage && historyOpen ? (
          <HistoryList activeId={conversationId} onPick={(id) => void openConversation(id)} />
        ) : restoring ? (
          <LoadingRow />
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={MessagesSquare}
              size="lg"
              title={t("chat.emptyTitle")}
              description={t("chat.emptyBody")}
            />
          </div>
        ) : (
          <div className={cn("flex flex-col gap-4 py-1", isPage && "mx-auto w-full max-w-4xl")}>
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "animate-in-up flex flex-col gap-2",
                  m.role === "user" ? "items-end" : "w-full items-start",
                )}
              >
                {/* Cards sit outside the bubble: they carry their own surface tone,
                    and tool results deserve more room than a reply bubble allows. */}
                {m.cards.length > 0 && (
                  <div className="flex w-full flex-col gap-2">
                    {m.cards.map((c) => (
                      <AgentCardView key={c.toolCallId} card={c.card} colors={accountColors} />
                    ))}
                  </div>
                )}
                {(m.content || m.streaming || m.toolCalls.length > 0 || m.error || m.systemPrompt) && (
                  <div
                    className={cn(
                      "text-sm",
                      m.role === "user"
                        ? "max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-accent-foreground"
                        : "w-full py-1 text-foreground",
                    )}
                  >
                    {m.systemPrompt ? (
                      <SystemPromptView prompt={m.systemPrompt} />
                    ) : m.role === "assistant" ? (
                      <AssistantSequence message={m} thinkingLabel={t("chat.thinking")} />
                    ) : (
                      <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                    )}
                    {m.error && (
                      <div role="alert" className={cn("text-destructive", (m.content || m.toolCalls.length > 0) && "mt-2")}>
                        {m.error}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div
        className={cn(
          "flex items-end gap-2 rounded-2xl bg-surface-2 p-1.5 pl-4",
          isPage && "mx-auto w-full max-w-4xl",
        )}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t("chat.placeholder")}
          rows={1}
          className="max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto bg-transparent py-2 text-base md:text-sm leading-relaxed [scrollbar-width:none] [-webkit-scrollbar]:hidden placeholder:text-muted-foreground focus:outline-none"
          aria-busy={busy}
        />
        <Button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          size="icon"
          className="mb-1 h-8 w-8 shrink-0 rounded-xl"
          aria-label={t("chat.send")}
        >
          {busy ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Send className="-translate-x-px translate-y-px" />
          )}
        </Button>
      </div>
    </div>
  );
}

function formatToolValue(value: unknown): string {
  if (value === undefined) return "Not available";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolActivity({ call }: { call: ChatToolCall }) {
  return (
    <details className="group my-1 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-foreground">
        {!call.done && <Loader2 className="h-3 w-3 animate-spin" />}
        <span>{call.name}</span>
        {call.detail && !call.done && <span className="truncate opacity-70">· {call.detail}</span>}
        {call.isError && <span className="text-destructive">· failed</span>}
      </summary>
      <div className="mt-1 space-y-2 border-l border-border pl-3">
        <div>
          <div className="mb-0.5 font-medium">Parameters</div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-[11px] text-foreground">
            {formatToolValue(call.parameters)}
          </pre>
        </div>
        <div>
          <div className="mb-0.5 font-medium">Result</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-2 font-mono text-[11px] text-foreground">
            {call.done ? formatToolValue(call.result) : "Running…"}
          </pre>
        </div>
      </div>
    </details>
  );
}

/** Keeps visible assistant prose in its actual position around tool calls. */
function AssistantSequence({ message, thinkingLabel }: { message: DisplayMessage; thinkingLabel: string }) {
  const calls = [...message.toolCalls].sort(
    (a, b) => (a.contentOffset ?? 0) - (b.contentOffset ?? 0),
  );
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (let i = 0; i < calls.length; ) {
    const callOffset = Math.max(offset, Math.min(message.content.length, calls[i]?.contentOffset ?? 0));
    const text = message.content.slice(offset, callOffset);
    if (text) parts.push(<Markdown key={`text-${i}`} content={text} />);
    let j = i;
    while (j < calls.length && (calls[j]?.contentOffset ?? 0) === (calls[i]?.contentOffset ?? 0)) {
      const call = calls[j];
      if (call) parts.push(<ToolActivity key={call.id} call={call} />);
      j++;
    }
    offset = callOffset;
    i = j;
  }
  const tail = message.content.slice(offset);
  if (tail) parts.push(<Markdown key="text-tail" content={tail} />);
  if (message.streaming && (message.thinking || parts.length === 0)) {
    parts.push(
      <div key="thinking" className="animate-pulse leading-relaxed text-muted-foreground">
        {thinkingLabel}
      </div>,
    );
  }
  return <>{parts}</>;
}

function HighlightedPrompt({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match = lowerText.indexOf(lowerQuery);
  while (match !== -1) {
    parts.push(text.slice(cursor, match));
    parts.push(
      <mark key={`${match}-${cursor}`} className="rounded-sm bg-accent/25 text-foreground">
        {text.slice(match, match + query.length)}
      </mark>,
    );
    cursor = match + query.length;
    match = lowerText.indexOf(lowerQuery, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Compact inspector returned by /sys, with literal prompt text and in-place matches. */
function SystemPromptView({ prompt }: { prompt: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const matchCount = normalized
    ? prompt.toLocaleLowerCase().split(normalized).length - 1
    : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <section className="overflow-hidden rounded-xl bg-surface-2" aria-label={t("chat.systemPrompt.title")}>
      <div className="flex flex-wrap items-center gap-2 p-2.5">
        <span className="px-1 text-xs font-semibold">{t("chat.systemPrompt.title")}</span>
        <div className="relative ml-auto min-w-40 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("chat.systemPrompt.search")}
            aria-label={t("chat.systemPrompt.search")}
            className="field h-8 w-full pl-8 pr-8 text-xs"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={t("common.close")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {normalized && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("chat.systemPrompt.matches", { count: matchCount })}
          </span>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t("chat.systemPrompt.copied") : t("chat.systemPrompt.copy")}
        </Button>
      </div>
      <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words bg-background/55 p-4 font-mono text-xs leading-relaxed">
        <HighlightedPrompt text={prompt} query={query.trim()} />
      </pre>
    </section>
  );
}

/** Past conversations, newest first; fetched fresh each time it opens. Search and
 * pagination are server-backed — this only ever holds one loaded "window". */
export function HistoryList({
  activeId,
  onPick,
  query = "",
}: {
  activeId: string | undefined;
  onPick: (id: string) => void;
  query?: string;
}) {
  const { t, i18n } = useTranslation();
  const [items, setItems] = React.useState<Conversation[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [debouncedQuery, setDebouncedQuery] = React.useState(query.trim());
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameDraft, setRenameDraft] = React.useState("");
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const renameHandled = React.useRef(false);

  // Server-backed search: wait ~250ms after typing stops before hitting the endpoint.
  React.useEffect(() => {
    const trimmed = query.trim();
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = React.useCallback(() => {
    api
      .conversations({ q: debouncedQuery || undefined, limit: CONVERSATIONS_PAGE_SIZE, offset: 0 })
      .then((res) => {
        setItems(res.items);
        setTotal(res.total);
      })
      .catch((err) => {
        toast.error(errorMessage(err));
        setItems([]);
        setTotal(0);
      });
  }, [debouncedQuery]);

  React.useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  // New chats and automation runs appear in the list as they happen. Simplest
  // correct behavior for an invalidation: refetch and reset to the first page.
  useServerEvents(["conversations"], load);

  // Chat creation is reported on the request's stream as well as the global
  // server-event stream. Listen to the local invalidation so a newly submitted
  // chat appears even if EventSource had not connected when it was created.
  React.useEffect(() => {
    window.addEventListener("trailin:conversations-changed", load);
    return () => window.removeEventListener("trailin:conversations-changed", load);
  }, [load]);

  const loadMore = async () => {
    if (!items) return;
    setLoadingMore(true);
    try {
      const res = await api.conversations({
        q: debouncedQuery || undefined,
        limit: CONVERSATIONS_PAGE_SIZE,
        offset: items.length,
      });
      setItems([...items, ...res.items]);
      setTotal(res.total);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const startRename = (c: Conversation) => {
    // Enter/Escape set this true and unmount the input without firing blur
    // (browsers don't dispatch focusout for a removed element), so a stale
    // true would swallow the next rename's blur-commit. Clear it up front.
    renameHandled.current = false;
    setRenamingId(c.id);
    setRenameDraft(c.title || "");
  };

  const commitRename = async (id: string) => {
    setRenamingId(null);
    const title = renameDraft.trim();
    if (!title) return; // empty edit — silently cancel rather than 400 the server
    setItems((prev) => prev?.map((c) => (c.id === id ? { ...c, title } : c)) ?? prev);
    try {
      await api.renameConversation(id, title);
    } catch (err) {
      toast.error(errorMessage(err));
      load();
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await api.deleteConversation(deleteId);
      if (deleteId === activeId) {
        // Same reset the "New chat" button triggers: clears messages, the open
        // conversation id, and the last-open-conversation localStorage key.
        window.dispatchEvent(new CustomEvent("trailin:new-chat"));
      }
      setItems((prev) => prev?.filter((c) => c.id !== deleteId) ?? prev);
      setTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDeleting(false);
      setDeleteId(null);
    }
  };

  const dateLabel = (iso: string) => dateTimeLabel(iso, i18n.language);

  const renderRow = (c: Conversation) => (
    <div
      key={c.id}
      className={cn(
        "group flex items-center gap-1 rounded-lg transition-colors",
        c.id === activeId ? "bg-accent/10" : "hover:bg-secondary",
      )}
    >
      {renamingId === c.id ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => setRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              renameHandled.current = true;
              void commitRename(c.id);
            } else if (e.key === "Escape") {
              renameHandled.current = true;
              setRenamingId(null);
            }
          }}
          onBlur={() => {
            if (renameHandled.current) {
              renameHandled.current = false;
              return;
            }
            void commitRename(c.id);
          }}
          className="field mx-1 my-1 h-7 min-w-0 flex-1 px-2 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => onPick(c.id)}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left"
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            {c.running && (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin text-accent"
                aria-label={t("chat.working")}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                c.id === activeId ? "font-medium text-accent" : "text-foreground",
              )}
            >
              {c.title || t("chat.untitled")}
            </span>
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {dateLabel(c.createdAt)}
          </span>
        </button>
      )}
      {renamingId !== c.id && (
        <div className="flex shrink-0 items-center gap-0.5 pr-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {c.type !== "automation" && (
            <IconButton
              onClick={(e) => {
                e.stopPropagation();
                startRename(c);
              }}
              aria-label={t("chat.rename")}
              title={t("chat.rename")}
              className="rounded-md p-1 hover:bg-secondary"
            >
              <Pencil className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              setDeleteId(c.id);
            }}
            aria-label={t("chat.delete")}
            title={t("chat.delete")}
            className="rounded-md p-1 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  );

  const dialog = (
    <ConfirmDialog
      open={deleteId !== null}
      onOpenChange={(next) => !next && setDeleteId(null)}
      title={t("chat.deleteConfirmTitle")}
      description={t("chat.deleteConfirmBody")}
      confirmLabel={t("chat.delete")}
      variant="destructive"
      busy={deleting}
      onConfirm={() => void confirmDelete()}
    />
  );

  if (!items) {
    return (
      <>
        <LoadingRow />
        {dialog}
      </>
    );
  }

  const loadMoreButton = items.length < total && (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void loadMore()}
      disabled={loadingMore}
      className="w-full text-muted-foreground"
    >
      {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {t("chat.loadMore")}
    </Button>
  );

  if (items.length === 0) {
    if (debouncedQuery) {
      return (
        <>
          <p className="px-1 py-2 text-xs text-muted-foreground">{t("chat.noSearchResults")}</p>
          {dialog}
        </>
      );
    }
    return (
      <>
        <div className="flex flex-col items-center justify-center gap-3 py-8 px-2 text-center">
          <p className="text-sm text-muted-foreground">{t("chat.noConversations")}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent("trailin:new-chat"))}
          >
            <Plus className="h-4 w-4 mr-1.5" />
            {t("chat.newConversation")}
          </Button>
        </div>
        {dialog}
      </>
    );
  }

  // While searching: one flat, ungrouped, unsectioned result list (chats + automations mixed).
  if (debouncedQuery) {
    return (
      <>
        <div className="flex flex-col gap-4 py-2 px-1">
          <div className="flex flex-col gap-1">{items.map(renderRow)}</div>
          {loadMoreButton}
        </div>
        {dialog}
      </>
    );
  }

  const chats = items.filter((c) => c.type !== "automation");
  const automations = items.filter((c) => c.type === "automation");
  const now = new Date();
  const grouped = RECENCY_ORDER.map((group) => ({
    group,
    items: chats.filter((c) => recencyGroup(c.createdAt, now) === group),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <div className="flex flex-col gap-4 py-2 px-1">
        {chats.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {t("chat.chats")}
            </h3>
            {grouped.map(({ group, items: groupItems }) => (
              <div key={group} className="flex flex-col gap-1">
                <h4 className="px-2 text-xs font-medium text-muted-foreground">
                  {t(RECENCY_LABEL_KEY[group])}
                </h4>
                {groupItems.map(renderRow)}
              </div>
            ))}
          </div>
        )}
        {automations.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="px-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {t("chat.automations")}
            </h3>
            {automations.map(renderRow)}
          </div>
        )}
        {loadMoreButton}
      </div>
      {dialog}
    </>
  );
}
