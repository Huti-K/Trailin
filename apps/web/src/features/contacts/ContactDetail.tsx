import {
  CONTACT_CATEGORIES,
  type ContactCategory,
  type ContactDetail as ContactDetailData,
} from "@trailin/shared";
import { ChevronLeft, ExternalLink } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/feedback";
import { Label } from "@/components/ui/label";
import { ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactAvatar, categoryLabel } from "@/features/contacts/shared";
import { api } from "@/lib/api";
import { dateTimeLabel, relativeTime } from "@/lib/dates";
import { useServerEvents } from "@/lib/serverEvents";
import { toast } from "@/lib/toast";
import { errorMessage, openExternal } from "@/lib/utils";

/**
 * One contact's full record: header, the one manual override (category),
 * recent threads, and its scoped memories. Swaps in for the People list
 * inside ContactsPanel — a single-pane drill-down, not a dialog.
 */
export function ContactDetail({ address, onBack }: { address: string; onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = React.useState<ContactDetailData | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    api
      .contactDetail(address)
      .then((data) => {
        setDetail(data);
        setLoadError(null);
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [address]);

  React.useEffect(() => {
    setDetail(null);
    setLoadError(null);
    load();
  }, [load]);

  useServerEvents(["contacts"], load);

  const updateCategory = async (value: string) => {
    if (!detail) return;
    const category = value as ContactCategory;
    const previous = detail;
    setDetail({ ...detail, category, categorySource: "user" });
    try {
      const updated = await api.setContactCategory(address, category);
      setDetail((current) => (current ? { ...current, ...updated } : current));
    } catch (err) {
      toast.error(err);
      setDetail(previous);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Button variant="ghost" size="sm" onClick={onBack} className="w-fit">
        <ChevronLeft className="h-4 w-4" />
        {t("contacts.detail.back")}
      </Button>

      {!detail ? (
        loadError ? (
          <div className="flex flex-col items-start gap-2">
            <ErrorBanner>{loadError}</ErrorBanner>
            <Button variant="ghost" size="sm" onClick={load}>
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <Skeleton className="h-12 w-12 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
            <Skeleton className="h-9 w-56 rounded-lg" />
          </div>
        )
      ) : (
        <>
          <div className="flex items-start gap-3">
            <ContactAvatar
              label={detail.displayName || detail.address}
              className="h-12 w-12 text-base"
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold tracking-tight">
                {detail.displayName || detail.address}
              </h2>
              <p className="truncate text-sm text-muted-foreground">{detail.address}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t("contacts.detail.messages", { count: detail.messageCount })}</span>
                <span aria-hidden>·</span>
                <span>{t("contacts.detail.sent", { count: detail.sentCount })}</span>
                <span aria-hidden>·</span>
                <span>
                  {t("contacts.detail.lastContact", {
                    when: relativeTime(detail.lastContactAt, i18n.language),
                  })}
                </span>
              </p>
            </div>
          </div>

          {detail.gist && <p className="text-sm text-muted-foreground">{detail.gist}</p>}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contact-category">{t("contacts.detail.categoryLabel")}</Label>
            <div className="w-56">
              <Select
                id="contact-category"
                value={detail.category}
                onChange={(value) => void updateCategory(value)}
                options={CONTACT_CATEGORIES.map((cat) => ({
                  value: cat,
                  label: categoryLabel(t, cat),
                }))}
              />
            </div>
            <p className="text-2xs text-muted-foreground/70">
              {detail.categorySource === "user"
                ? t("contacts.detail.categorySourceUser")
                : t("contacts.detail.categorySourceAuto")}
            </p>
          </div>

          <section className="flex flex-col gap-2.5">
            <h3 className="text-sm font-semibold tracking-tight">
              {t("contacts.detail.threadsTitle")}
            </h3>
            {detail.recentThreads.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("contacts.detail.noThreads")}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.recentThreads.map((thread) => (
                  <ListRow key={`${thread.accountId}-${thread.threadId}`}>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {thread.subject || t("drafts.noSubject")}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {dateTimeLabel(thread.date, i18n.language)}
                        {thread.gist && ` · ${thread.gist}`}
                      </p>
                    </div>
                    {thread.webUrl && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0"
                        onClick={() => openExternal(thread.webUrl)}
                        title={t("drafts.open")}
                        aria-label={t("drafts.open")}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    )}
                  </ListRow>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
