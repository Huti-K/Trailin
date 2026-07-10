import type { FastifyInstance } from "fastify";
import { isLanguage, SUPPORTED_LANGUAGES } from "@trailin/shared";
import {
  EMAIL_WRITE_SETTING_KEY,
  getAccountColors,
  getAccountDescriptions,
  getEmailWriteSetting,
  getLanguageSetting,
  getTimezoneSetting,
  isValidTimezone,
  LANGUAGE_SETTING_KEY,
  setAccountColors,
  setAccountDescriptions,
  setSetting,
  TIMEZONE_SETTING_KEY,
} from "../db/settings.js";
import { resetSessions } from "../agent/emailAgent.js";
import { rescheduleAll } from "../automations/scheduler.js";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings/language", async () => ({ language: await getLanguageSetting() }));

  app.put<{ Body: { language: string } }>("/api/settings/language", async (req, reply) => {
    const language = req.body?.language;
    if (!isLanguage(language)) {
      return reply
        .code(400)
        .send({ error: `language must be one of: ${SUPPORTED_LANGUAGES.join(", ")}` });
    }
    await setSetting(LANGUAGE_SETTING_KEY, language);
    // The language lives in the system prompt, so drop in-memory agents —
    // new conversations (and scheduled runs) pick it up immediately.
    await resetSessions();
    return { language };
  });

  app.get("/api/settings/timezone", async () => ({ timezone: await getTimezoneSetting() }));

  app.put<{ Body: { timezone: string } }>("/api/settings/timezone", async (req, reply) => {
    const timezone = req.body?.timezone;
    if (!isValidTimezone(timezone)) {
      return reply.code(400).send({ error: "timezone must be a valid IANA timezone" });
    }
    await setSetting(TIMEZONE_SETTING_KEY, timezone);
    // node-cron bakes the timezone into each task when it is created, so the
    // existing tasks would keep firing on the old zone until a restart.
    await rescheduleAll();
    // The current time is baked into the system prompt, so drop in-memory
    // agents — the next prompt in every conversation picks up the change.
    await resetSessions();
    return { timezone };
  });

  app.get("/api/settings/email-write", async () => ({
    allowWrite: await getEmailWriteSetting(),
  }));

  app.put<{ Body: { allowWrite: boolean } }>("/api/settings/email-write", async (req, reply) => {
    if (typeof req.body?.allowWrite !== "boolean") {
      return reply.code(400).send({ error: "allowWrite must be a boolean" });
    }
    await setSetting(EMAIL_WRITE_SETTING_KEY, String(req.body.allowWrite));
    // The guard decides which tools get registered — rebuild agent toolsets.
    await resetSessions();
    return { allowWrite: req.body.allowWrite };
  });

  // ---- Account colors ----

  app.get("/api/settings/account-colors", async () => ({
    colors: await getAccountColors(),
  }));

  app.put<{ Body: { colors: import("@trailin/shared").AccountColor[] } }>(
    "/api/settings/account-colors",
    async (req, reply) => {
      const colors = req.body?.colors;
      if (!Array.isArray(colors)) {
        return reply.code(400).send({ error: "colors must be an array" });
      }
      // Basic validation: each entry needs accountId and hex
      for (const c of colors) {
        if (!c.accountId || !c.hex) {
          return reply.code(400).send({ error: "each color must have accountId and hex" });
        }
      }
      await setAccountColors(colors);
      return { colors };
    },
  );

  // ---- Account descriptions (the "what is this connection for" note) ----

  app.get("/api/settings/account-descriptions", async () => ({
    descriptions: await getAccountDescriptions(),
  }));

  app.put<{ Body: { descriptions: import("@trailin/shared").AccountDescription[] } }>(
    "/api/settings/account-descriptions",
    async (req, reply) => {
      const descriptions = req.body?.descriptions;
      if (!Array.isArray(descriptions)) {
        return reply.code(400).send({ error: "descriptions must be an array" });
      }
      for (const d of descriptions) {
        if (!d.accountId || typeof d.text !== "string") {
          return reply.code(400).send({ error: "each description must have accountId and text" });
        }
      }
      await setAccountDescriptions(descriptions);
      // Descriptions are baked into each tool's description string, so rebuild
      // in-memory agents to surface the new purpose to the model right away.
      await resetSessions();
      return { descriptions };
    },
  );
}
