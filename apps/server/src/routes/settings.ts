import type { FastifyInstance } from "fastify";
import { isLanguage, SUPPORTED_LANGUAGES } from "@trailin/shared";
import {
  EMAIL_WRITE_SETTING_KEY,
  getAccountColors,
  getAccountDescriptions,
  getAccountVoices,
  getEmailWriteSetting,
  getLanguageSetting,
  getTimezoneSetting,
  isValidTimezone,
  LANGUAGE_SETTING_KEY,
  setAccountColors,
  setAccountDescriptions,
  setAccountVoices,
  setSetting,
  TIMEZONE_SETTING_KEY,
} from "../db/settings.js";
import { resetSessions } from "../agent/emailAgent.js";
import { learnAccountVoice } from "../agent/voiceLearn.js";
import { listAccounts } from "../pipedream/connect.js";
import { errorMessage } from "../util.js";

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

  // ---- Account voices (signature for drafting as an account; writing style
  // lives as account-scoped memories now, not here) ----

  app.get("/api/settings/account-voices", async () => ({
    voices: await getAccountVoices(),
  }));

  app.put<{ Body: { voices: import("@trailin/shared").AccountVoice[] } }>(
    "/api/settings/account-voices",
    async (req, reply) => {
      const voices = req.body?.voices;
      if (!Array.isArray(voices)) {
        return reply.code(400).send({ error: "voices must be an array" });
      }
      for (const v of voices) {
        if (!v.accountId) {
          return reply.code(400).send({ error: "each voice must have an accountId" });
        }
        if (v.signature !== undefined && typeof v.signature !== "string") {
          return reply.code(400).send({ error: "signature must be a string" });
        }
      }
      // The UI only edits signatures, so an incoming voice never carries the
      // server-managed learnedAt/styleMemoryIds fields — merge them back in
      // from the currently stored voice so a signature-only edit doesn't wipe
      // the record of a prior voice-learn run.
      const stored = await getAccountVoices();
      const merged = voices.map((v) => {
        const existing = stored.find((s) => s.accountId === v.accountId);
        return {
          ...v,
          ...(v.learnedAt !== undefined || existing?.learnedAt !== undefined
            ? { learnedAt: v.learnedAt ?? existing?.learnedAt }
            : {}),
          ...(v.styleMemoryIds !== undefined || existing?.styleMemoryIds !== undefined
            ? { styleMemoryIds: v.styleMemoryIds ?? existing?.styleMemoryIds }
            : {}),
        };
      });
      await setAccountVoices(merged);
      // The signature is looked up fresh by the create-draft tool at save
      // time, and buildVoiceContext recomputes on every prompt (see
      // getOrCreateSession) — no session reset needed.
      return { voices: merged };
    },
  );

  // Derives writing-style directives (saved as account-scoped memories) and a
  // signature (saved on the voice) from the account's own sent mail. Runs an
  // ephemeral agent through several tool round-trips — legitimately 30-90s,
  // not a hung request.
  app.post<{ Params: { accountId: string } }>(
    "/api/settings/account-voices/:accountId/learn",
    async (req, reply) => {
      try {
        const { accountId } = req.params;
        const accounts = await listAccounts();
        if (!accounts.some((a) => a.id === accountId)) {
          return reply.code(404).send({ error: `No connected account with id ${accountId}.` });
        }
        const voice = await learnAccountVoice(accountId);
        // No session reset needed, same reasoning as the PUT above.
        return { voice };
      } catch (error) {
        return reply.code(500).send({ error: errorMessage(error) });
      }
    },
  );
}
