import { EMAIL_APPS } from "@trailin/shared";
import { demoSyncProvider } from "../../demo/demoSync.js";
import { env } from "../../env.js";
import { gmailSyncProvider } from "../gmailSync.js";
import { outlookSyncProvider } from "../outlookSync.js";
import { registerSyncProvider } from "./syncProviders.js";

/**
 * The one place SyncProviders are registered — mirrors ../registerProviders.ts
 * and, like it, registers HERE explicitly rather than as an import side
 * effect in each provider file, so the demo-wins-in-demo-mode ordering can't
 * be broken by some other module importing a provider file first (see the
 * ordering-bug note in registerProviders.ts).
 *
 * Adding a new provider is one new file implementing SyncProvider plus one
 * import + register line here — nothing else changes. The demo registration
 * comes LAST on purpose: in demo mode it covers every email app over the
 * real drivers so nothing ever calls out to Pipedream.
 */
registerSyncProvider("gmail", gmailSyncProvider);
registerSyncProvider("microsoft_outlook", outlookSyncProvider);
if (env.demoMode) {
  for (const app of EMAIL_APPS) registerSyncProvider(app, demoSyncProvider);
}
