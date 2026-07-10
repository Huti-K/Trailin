import { registerAttachmentProvider } from "./attachmentProviders.js";
import { gmailAttachmentProvider } from "./gmailAttachments.js";

/**
 * The one place AttachmentProviders are registered — mirrors
 * ./registerProviders.ts (and its rationale for registering HERE explicitly
 * rather than as an import side effect in each provider file).
 *
 * No demo registration: demo mode swaps the whole email toolset
 * (pipedream/mcp.ts's loadEmailTools) before attachment tools are wired, and
 * the demo mailbox has no attachments. No Outlook provider yet — absence
 * just means the account gets no save-attachment tool, same as an app
 * without a DraftProvider gets no draft tool.
 */
registerAttachmentProvider("gmail", gmailAttachmentProvider);
