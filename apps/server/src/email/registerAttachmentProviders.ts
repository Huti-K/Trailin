import { registerAttachmentProvider } from "./attachmentProviders.js";
import { gmailAttachmentProvider } from "./gmail/attachments.js";
import { outlookAttachmentProvider } from "./outlook/attachments.js";

registerAttachmentProvider("gmail", gmailAttachmentProvider);
registerAttachmentProvider("microsoft_outlook", outlookAttachmentProvider);
