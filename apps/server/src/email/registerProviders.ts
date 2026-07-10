import { EMAIL_APPS } from "@trailin/shared";
import { demoDraftProvider } from "../demo/demoDrafts.js";
import { env } from "../env.js";
import { gmailDraftProvider } from "./gmailDrafts.js";
import { outlookDraftProvider } from "./outlookDrafts.js";
import { registerDraftProvider } from "./providers.js";

/**
 * The one place DraftProviders are registered — anything that resolves
 * providers via getDraftProvider should import this first. Registration
 * happens HERE, explicitly, not as an import side effect in each provider
 * file: side-effect registration made the winner depend on module execution
 * order, and ESM caching means "import the demo provider last" silently
 * stops working the moment any other module imports a provider file directly
 * (that bug shipped once — emailTools importing demoDrafts ran demo's
 * registration before gmailDrafts' and the live driver won in demo mode).
 *
 * Adding a new provider (e.g. zoho_mail) is one new file implementing
 * DraftProvider plus one import + register line here — nothing else changes.
 * The demo registration comes LAST on purpose: in demo mode it covers every
 * email app over the real drivers so nothing ever calls out to a live API.
 */
registerDraftProvider("gmail", gmailDraftProvider);
registerDraftProvider("microsoft_outlook", outlookDraftProvider);
if (env.demoMode) {
  for (const app of EMAIL_APPS) registerDraftProvider(app, demoDraftProvider);
}
