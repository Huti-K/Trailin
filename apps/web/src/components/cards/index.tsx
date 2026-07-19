import type { AccountColor, AgentCard, CardAccount } from "@trailin/shared";
import { accountColor } from "@/lib/accounts";
import { AttachmentsCard } from "./AttachmentsCard";
import { BriefingCard } from "./BriefingCard";
import { ChoicesCard } from "./ChoicesCard";
import { EmailDraftCard } from "./EmailDraftCard";
import { MessageDraftCard } from "./MessageDraftCard";

/**
 * Registry mapping an `AgentCard.kind` to its presentation component,
 * resolving the account's hex from `colors` by `accountId` before handing it
 * down. Falls through to `null` for a `kind` this switch doesn't recognize —
 * the server can ship a new card kind before this client has shipped the
 * component for it, and that must degrade silently rather than crash chat.
 */
export function AgentCardView({ card, colors }: { card: AgentCard; colors?: AccountColor[] }) {
  const hex = (account?: CardAccount) => accountColor(colors, account?.accountId);

  switch (card.kind) {
    case "email_draft":
      return <EmailDraftCard card={card} color={hex(card.account)} />;
    case "message_draft":
      return <MessageDraftCard card={card} />;
    case "attachments":
      return <AttachmentsCard card={card} color={hex(card.account)} />;
    case "briefing":
      return <BriefingCard card={card} colors={colors} />;
    case "choices":
      return <ChoicesCard card={card} colors={colors} />;
    default:
      return null;
  }
}
