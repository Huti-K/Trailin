import type { ConnectedAccount, MemoryEntry } from "@marlen/shared";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FileEditor } from "@/features/knowledge/FileEditor";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";

/**
 * Voice-learn status for one account row: an in-flight or failed attempt, or
 * the learned voice itself — a chip whose tooltip lists the style directives
 * and which opens the backing style memory in the editor. A learn starting or
 * finishing emits "learn", which the topic bridge turns into a refetch of
 * both queries.
 */
export function VoiceLearnBadge({ account }: { account: ConnectedAccount }) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState<MemoryEntry | null>(null);
  const { data: runs } = useQuery({
    queryKey: ["learn", "voiceRuns"],
    queryFn: () => api.voiceLearnRuns(),
  });
  const { data: voices } = useQuery({
    queryKey: ["learn", "voices"],
    queryFn: () => api.accountVoices(),
  });
  const run = runs?.find((r) => r.accountId === account.id);

  if (run?.status === "running") {
    return (
      <Badge variant="muted">
        <Spinner className="h-3 w-3" />
        {t("connections.voiceLearning")}
      </Badge>
    );
  }

  if (run?.status === "error") {
    // Reruns a failed (or skipped) attempt from the row.
    const retry = async () => {
      try {
        await api.learnAccountVoice(account.id);
        toast.success(t("connections.learnVoiceStarted", { name: account.name }));
      } catch (err) {
        toast.error(err);
      }
    };
    return (
      <>
        <Badge variant="destructive" data-tooltip={run.error ?? undefined}>
          {t("connections.voiceLearnFailed")}
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void retry()}
          aria-label={t("connections.voiceLearnRetry")}
          data-tooltip={t("connections.voiceLearnRetry")}
        >
          <RotateCcw />
        </Button>
      </>
    );
  }

  const voice = voices?.find((v) => v.accountId === account.id);
  if (voice) {
    const edit = async () => {
      if (!voice.memoryId) return;
      try {
        const entry = (await api.memories()).find((m) => m.id === voice.memoryId);
        if (entry) setEditing(entry);
      } catch (err) {
        toast.error(err);
      }
    };
    return (
      <>
        <button
          type="button"
          onClick={() => void edit()}
          className={badgeVariants({ variant: "muted" })}
          data-tooltip={voice.directives.join("\n")}
          aria-label={t("connections.voiceEdit")}
        >
          <AudioLines aria-hidden />
          {t("connections.voiceLearned")}
        </button>
        {editing && (
          <FileEditor
            target={{ kind: "memory", entry: editing }}
            onClose={() => setEditing(null)}
            onStatus={() => {}}
          />
        )}
      </>
    );
  }

  return null;
}
