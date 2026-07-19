import { gmailDraftProvider } from "./gmail/drafts.js";
import { outlookDraftProvider } from "./outlook/drafts.js";
import { registerDraftProvider } from "./providers.js";

/**
 * The one place DraftProviders are registered. Registration is explicit here,
 * not an import side effect in each provider file: side-effect registration
 * would let the winner depend on module execution order, which ESM caching
 * ties to whichever module imports a provider file first.
 */
registerDraftProvider("gmail", gmailDraftProvider);
registerDraftProvider("microsoft_outlook", outlookDraftProvider);
