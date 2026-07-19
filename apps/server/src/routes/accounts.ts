import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { AppStatus } from "@trailin/shared";
import { EMAIL_APPS } from "@trailin/shared";
import { activeModelConfigured, getActiveModelIds } from "../agent/llm/registry.js";
import { getOnOfficeConfig } from "../integrations/onoffice/config.js";
import { listAccounts, pipedreamConfigured } from "../integrations/pipedream/connect.js";

export const accountRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/status", async (): Promise<AppStatus> => {
    const { provider, model } = await getActiveModelIds();
    const configured = await pipedreamConfigured();
    // A Pipedream failure reports the count as unknown, not a false zero.
    let emailAccounts = 0;
    let emailAccountsKnown = true;
    if (configured) {
      try {
        // Only mail apps count toward the setup gate; a Notion/Slack link alone isn't "set up".
        const accounts = await listAccounts();
        emailAccounts = accounts.filter((a) =>
          (EMAIL_APPS as readonly string[]).includes(a.app),
        ).length;
      } catch {
        emailAccountsKnown = false;
      }
    }
    return {
      pipedreamConfigured: configured,
      modelConfigured: await activeModelConfigured(),
      emailAccounts,
      emailAccountsKnown,
      onofficeConfigured: (await getOnOfficeConfig()) !== null,
      provider,
      model,
    };
  });
};
