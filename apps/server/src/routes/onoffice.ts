import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { resetSessions } from "../agent/sessionCache.js";
import {
  pauseOnOfficeDefaults,
  resumeOnOfficeDefaults,
  seedDefaultAutomations,
} from "../automations/defaults.js";
import { rescheduleAll } from "../automations/scheduler.js";
import { badRequest } from "../core/errors.js";
import { errorMessage } from "../core/utils/util.js";
import { setOnOfficeAutomationCreates, setOnOfficeWriteAccess } from "../db/settings.js";
import {
  clearOnOfficeConfig,
  getOnOfficeStatus,
  saveOnOfficeConfig,
} from "../integrations/onoffice/config.js";

// The secret is never returned to the browser, so an edit may omit either field to keep the saved one.
const onOfficeConfigBody = Type.Object({
  token: Type.Optional(Type.String()),
  secret: Type.Optional(Type.String()),
});

export const onOfficeRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/onoffice", async () => getOnOfficeStatus());

  app.put("/api/onoffice", { schema: { body: onOfficeConfigBody } }, async (req) => {
    try {
      await saveOnOfficeConfig({ token: req.body.token, secret: req.body.secret });
    } catch (error) {
      throw badRequest(errorMessage(error));
    }
    // Live agents hold an onOffice client built from the old credentials.
    await resetSessions();
    // Seed the requiresOnOffice defaults (or resume ones a disconnect paused),
    // then reschedule so freshly seeded rows run.
    await seedDefaultAutomations();
    await resumeOnOfficeDefaults();
    await rescheduleAll();
    return getOnOfficeStatus();
  });

  app.delete("/api/onoffice", async () => {
    await clearOnOfficeConfig();
    await resetSessions();
    // Without credentials these runs would fire without their lead/onOffice tools; pause until they return.
    await pauseOnOfficeDefaults();
    return getOnOfficeStatus();
  });

  // Each automation run builds a fresh agent, so this takes effect next run
  // without a session reset (unlike write-access below).
  app.put(
    "/api/onoffice/automation-creates",
    { schema: { body: Type.Object({ enabled: Type.Boolean() }) } },
    async (req) => {
      await setOnOfficeAutomationCreates(req.body.enabled);
      return getOnOfficeStatus();
    },
  );

  // Live agents hold the tool list built under the old setting, so flipping it
  // resets sessions (unlike the per-run automation toggle above).
  app.put(
    "/api/onoffice/write-access",
    { schema: { body: Type.Object({ enabled: Type.Boolean() }) } },
    async (req) => {
      await setOnOfficeWriteAccess(req.body.enabled);
      await resetSessions();
      return getOnOfficeStatus();
    },
  );
};
