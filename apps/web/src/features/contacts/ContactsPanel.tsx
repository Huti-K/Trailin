import * as React from "react";
import { useTranslation } from "react-i18next";
import { Chip } from "@/components/ui/chip";
import { ContactDetail } from "@/features/contacts/ContactDetail";
import { NewslettersLane } from "@/features/contacts/NewslettersLane";
import { PeopleLane } from "@/features/contacts/PeopleLane";

type Lane = "people" | "newsletters";

/**
 * Contacts: every person and list that mails you, in one place (server:
 * email/contacts/, email/unsubscribe/). Two lanes — People and Newsletters —
 * switched by the chip row; selecting a person swaps the whole panel for
 * their detail view, a single-pane drill-down rather than a dialog.
 */
export function ContactsPanel() {
  const { t } = useTranslation();
  const [lane, setLane] = React.useState<Lane>("people");
  const [selectedAddress, setSelectedAddress] = React.useState<string | null>(null);

  if (selectedAddress) {
    return (
      <div className="pt-4">
        <ContactDetail address={selectedAddress} onBack={() => setSelectedAddress(null)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex items-center gap-1.5">
        <Chip active={lane === "people"} onClick={() => setLane("people")}>
          {t("contacts.lanes.people")}
        </Chip>
        <Chip active={lane === "newsletters"} onClick={() => setLane("newsletters")}>
          {t("contacts.lanes.newsletters")}
        </Chip>
      </div>

      {lane === "people" ? <PeopleLane onOpen={setSelectedAddress} /> : <NewslettersLane />}
    </div>
  );
}
