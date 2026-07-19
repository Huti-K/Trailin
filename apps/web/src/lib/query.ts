import { QueryClient } from "@tanstack/react-query";
import type { ServerEventTopic } from "@trailin/shared";
import { subscribeServerEvents } from "@/lib/serverEvents";

/**
 * The app's one QueryClient. Freshness is push-driven: the SSE topic bridge
 * below invalidates by topic, so queries don't poll or refetch on focus —
 * server-side changes announce themselves.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * Every data topic the server broadcasts, as a Record so adding a topic to
 * ServerEventTopic without wiring it here is a compile error. "notification"
 * is excluded — it carries payloads and has its own subscription path
 * (subscribeRunNotifications).
 */
const DATA_TOPICS: Record<Exclude<ServerEventTopic, "notification">, true> = {
  runs: true,
  drafts: true,
  todos: true,
  memories: true,
  skills: true,
  library: true,
  conversations: true,
  automations: true,
  learn: true,
  leads: true,
  whatsapp: true,
  accounts: true,
};

/**
 * Query-key convention: a key's first element is the topic that invalidates
 * it — ["drafts", accountId], ["automations"]. One standing subscription per
 * topic maps every server-side change onto the matching key prefix.
 */
export function startTopicInvalidation(): () => void {
  const unsubscribes = (Object.keys(DATA_TOPICS) as ServerEventTopic[]).map((topic) =>
    subscribeServerEvents([topic], () => {
      void queryClient.invalidateQueries({ queryKey: [topic] });
    }),
  );
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
