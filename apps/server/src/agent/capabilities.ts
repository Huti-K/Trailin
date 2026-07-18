import {
  getOnOfficeAutomationCreates,
  getOnOfficeWriteAccess,
  getWhatsAppSendAccess,
} from "../db/settings.js";
import { getOnOfficeConfig } from "../onoffice/config.js";
import { isWhatsAppLinked } from "../whatsapp/session.js";

/**
 * The capability profile a session runs under. Both the toolset wiring
 * (assembly.ts's buildAgent, the loadEmailTools calls) and the system-prompt
 * prose (prompt.ts's buildSystemPrompt) derive from this one record, so what
 * the tools can do and what the prompt says about them cannot drift apart.
 */
export interface SessionCapabilities {
  /**
   * False for unattended scheduled runs: no human reviews an action before
   * it happens (or is present to click a choices card), so write surfaces
   * and standing-instruction tools are withheld throughout.
   */
  interactive: boolean;
  /** Whether account permission grants may arm provider write tools (loadEmailTools). */
  providerWrites: boolean;
  onOffice: {
    /** onOffice credentials exist; without them the whole CRM and lead surface is absent. */
    configured: boolean;
    /** The CRM modify/delete/send surface is armed — never for unattended runs. */
    writes: boolean;
    /** The additive CRM create surface (addresses, appointments, tasks, relations) is armed. */
    creates: boolean;
  };
  whatsapp: {
    /** A personal WhatsApp is paired; without it the whole surface is absent. */
    linked: boolean;
    /** whatsapp_send_message is armed — its Settings grant, never for unattended runs. */
    sends: boolean;
  };
}

/** Reads the settings once and derives the profile for one session build. */
export async function sessionCapabilities(interactive: boolean): Promise<SessionCapabilities> {
  const configured = (await getOnOfficeConfig()) !== null;
  const whatsappLinked = isWhatsAppLinked();
  return {
    interactive,
    providerWrites: interactive,
    onOffice: {
      configured,
      writes: configured && interactive && (await getOnOfficeWriteAccess()),
      creates: configured && (interactive || (await getOnOfficeAutomationCreates())),
    },
    whatsapp: {
      linked: whatsappLinked,
      sends: whatsappLinked && interactive && (await getWhatsAppSendAccess()),
    },
  };
}
