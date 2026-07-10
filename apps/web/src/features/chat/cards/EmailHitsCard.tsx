import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentCard } from "@trailin/shared";
import { relativeTime } from "@/lib/dates";
import { CardShell } from "./CardShell";

type EmailHitsData = Extract<AgentCard, { kind: "email_hits" }>;

/** The find-email result list: the query as title, then one compact two-line row per hit. */
export function EmailHitsCard({ card, color }: { card: EmailHitsData; color?: string }) {
  const { t, i18n } = useTranslation();
  const { account, query, hits, truncated } = card;

  return (
    <CardShell
      icon={Search}
      label={t("chat.cards.hits.title")}
      meta={t("chat.cards.hits.resultCount", { count: hits.length })}
      title={query ? `“${query}”` : undefined}
      account={account}
      color={color}
    >
      {hits.length === 0 ? (
        <p className="px-4 pb-4 text-xs text-muted-foreground">{t("chat.cards.hits.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3 px-4 pb-4 pt-1">
          {hits.map((hit) => (
            <div key={hit.messageId} className="flex min-w-0 flex-col gap-0.5">
              <div className="flex items-baseline gap-3">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">
                  {hit.subject || t("chat.cards.noSubject")}
                </p>
                <time className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {relativeTime(hit.date, i18n.language)}
                </time>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {hit.from}
                {hit.snippet && <span className="text-muted-foreground/70"> — {hit.snippet}</span>}
              </p>
            </div>
          ))}
          {truncated && (
            <p className="font-mono text-[11px] text-muted-foreground/70">
              {t("chat.cards.hits.truncatedLabel")}
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
}
