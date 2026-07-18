import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { isLanguage, SUPPORTED_LANGUAGES } from "@trailin/shared";
import { resetSessions } from "../agent/sessionCache.js";
import { rescheduleAll } from "../automations/scheduler.js";
import { rescheduleNightlySuggest } from "../automations/suggestService.js";
import {
  getAccountColors,
  getAccountPermissions,
  getFileAccessSettings,
  getLanguageSetting,
  getTimezoneSetting,
  isValidTimezone,
  LANGUAGE_SETTING_KEY,
  setAccountColors,
  setAccountPermissions,
  setFileAccessSettings,
  setSetting,
  TIMEZONE_SETTING_KEY,
} from "../db/settings.js";
import { rescheduleNightlyLearn } from "../email/learn/service.js";
import { badRequest } from "../errors.js";

const languageBody = Type.Object({ language: Type.String() });

const timezoneBody = Type.Object({ timezone: Type.String() });

const accountPermissionsBody = Type.Object({
  permissions: Type.Array(
    Type.Object({
      accountId: Type.String(),
      write: Type.Boolean(),
      send: Type.Boolean(),
      delete: Type.Boolean(),
    }),
  ),
});

const fileAccessBody = Type.Object({
  read: Type.Boolean(),
  write: Type.Boolean(),
  bash: Type.Boolean(),
});

const accountColorsBody = Type.Object({
  colors: Type.Array(Type.Object({ accountId: Type.String(), hex: Type.String() })),
});

export const settingsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/settings/language", async () => ({ language: await getLanguageSetting() }));

  app.put("/api/settings/language", { schema: { body: languageBody } }, async (req) => {
    const language = req.body.language;
    if (!isLanguage(language)) {
      throw badRequest(`language must be one of: ${SUPPORTED_LANGUAGES.join(", ")}`);
    }
    await setSetting(LANGUAGE_SETTING_KEY, language);
    // The language lives in the system prompt, so drop in-memory agents —
    // new conversations (and scheduled runs) pick it up immediately.
    await resetSessions();
    return { language };
  });

  app.get("/api/settings/timezone", async () => ({ timezone: await getTimezoneSetting() }));

  app.put("/api/settings/timezone", { schema: { body: timezoneBody } }, async (req) => {
    const timezone = req.body.timezone;
    if (!isValidTimezone(timezone)) {
      throw badRequest("timezone must be a valid IANA timezone");
    }
    await setSetting(TIMEZONE_SETTING_KEY, timezone);
    // node-cron bakes the timezone into each task when it is created, so
    // every cron-driven schedule is rebuilt against the new zone: the user's
    // automations plus the fixed nightly jobs (learning extraction and the
    // automation-suggestion sweep) — otherwise they'd keep firing on the old
    // zone until a restart.
    await rescheduleAll();
    await rescheduleNightlyLearn();
    await rescheduleNightlySuggest();
    // The current time is baked into the system prompt, so drop in-memory
    // agents — the next prompt in every conversation picks up the change.
    await resetSessions();
    return { timezone };
  });

  app.get("/api/settings/permissions", async () => ({
    permissions: await getAccountPermissions(),
  }));

  app.put(
    "/api/settings/permissions",
    { schema: { body: accountPermissionsBody } },
    async (req) => {
      // Last entry wins per account; all-false records are dropped so the
      // stored list only names accounts with at least one grant (absence is
      // the read-only default).
      const byId = new Map(req.body.permissions.map((p) => [p.accountId, p]));
      const permissions = [...byId.values()].filter((p) => p.write || p.send || p.delete);
      await setAccountPermissions(permissions);
      // The per-account grants decide which tools get registered — rebuild agent toolsets.
      await resetSessions();
      return { permissions };
    },
  );

  // ---- File access ----

  app.get("/api/settings/file-access", async () => ({
    fileAccess: await getFileAccessSettings(),
  }));

  app.put("/api/settings/file-access", { schema: { body: fileAccessBody } }, async (req) => {
    const fileAccess = req.body;
    await setFileAccessSettings(fileAccess);
    // The grants decide which file tools buildAgent mounts and what the
    // system prompt says about them — rebuild agent sessions.
    await resetSessions();
    return { fileAccess };
  });

  // ---- Account colors ----

  app.get("/api/settings/account-colors", async () => ({
    colors: await getAccountColors(),
  }));

  app.put("/api/settings/account-colors", { schema: { body: accountColorsBody } }, async (req) => {
    await setAccountColors(req.body.colors);
    return { colors: req.body.colors };
  });
};
