import { gmailReadProvider } from "../gmail/read.js";
import { outlookReadProvider } from "../outlook/read.js";
import { registerMailReadProvider } from "./readProviders.js";

registerMailReadProvider("gmail", gmailReadProvider);
registerMailReadProvider("microsoft_outlook", outlookReadProvider);
