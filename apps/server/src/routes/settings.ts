import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { isLanguage, SUPPORTED_LANGUAGES } from "@trailin/shared";
import { resetSessions } from "../agent/sessionCache.js";
import { rescheduleAll } from "../automations/scheduler.js";
import { rescheduleNightlySuggest } from "../automations/suggest.js";
import { badRequest } from "../core/errors.js";
import { emitServerEvent } from "../core/events.js";
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
    // The language lives in the system prompt, so drop in-memory agents; new conversations pick it up.
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
    // node-cron bakes the timezone into each task at creation, so every schedule
    // (user automations plus the nightly learn and suggest jobs) is rebuilt;
    // otherwise they keep firing on the old zone until a restart.
    await rescheduleAll();
    await rescheduleNightlyLearn();
    await rescheduleNightlySuggest();
    // The current time is baked into the system prompt, so drop in-memory agents.
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
      // Last entry wins per account; all-false records are dropped so absence
      // means the read-only default.
      const byId = new Map(req.body.permissions.map((p) => [p.accountId, p]));
      const permissions = [...byId.values()].filter((p) => p.write || p.send || p.delete);
      await setAccountPermissions(permissions);
      // Per-account grants decide which tools get registered; rebuild agent toolsets.
      await resetSessions();
      emitServerEvent("accounts");
      return { permissions };
    },
  );

  app.get("/api/settings/file-access", async () => ({
    fileAccess: await getFileAccessSettings(),
  }));

  app.put("/api/settings/file-access", { schema: { body: fileAccessBody } }, async (req) => {
    const fileAccess = req.body;
    await setFileAccessSettings(fileAccess);
    // The grants decide which file tools buildAgent mounts and the prompt text; rebuild sessions.
    await resetSessions();
    return { fileAccess };
  });

  app.get("/api/settings/account-colors", async () => ({
    colors: await getAccountColors(),
  }));

  app.put("/api/settings/account-colors", { schema: { body: accountColorsBody } }, async (req) => {
    await setAccountColors(req.body.colors);
    emitServerEvent("accounts");
    return { colors: req.body.colors };
  });
};
