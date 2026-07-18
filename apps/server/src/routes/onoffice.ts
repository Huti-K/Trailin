import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { resetSessions } from "../agent/sessionCache.js";
import {
  pauseOnOfficeDefaults,
  resumeOnOfficeDefaults,
  seedDefaultAutomations,
} from "../automations/defaults.js";
import { rescheduleAll } from "../automations/scheduler.js";
import { setOnOfficeAutomationCreates, setOnOfficeWriteAccess } from "../db/settings.js";
import { badRequest } from "../errors.js";
import { clearOnOfficeConfig, getOnOfficeStatus, saveOnOfficeConfig } from "../onoffice/config.js";
import { errorMessage } from "../utils/util.js";

// Either field may be omitted to keep the saved one (the secret is never
// returned to the browser, so an edit re-sends only what changed).
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
    // The lead workflow exists only alongside the CRM: connecting it seeds the
    // requiresOnOffice defaults (first time) or resumes ones a disconnect
    // paused, then rebuilds the cron tasks so freshly seeded rows run.
    await seedDefaultAutomations();
    await resumeOnOfficeDefaults();
    await rescheduleAll();
    return getOnOfficeStatus();
  });

  app.delete("/api/onoffice", async () => {
    await clearOnOfficeConfig();
    await resetSessions();
    // Their runs would fire without the lead/onOffice tools they're written
    // around — pause them until credentials return.
    await pauseOnOfficeDefaults();
    return getOnOfficeStatus();
  });

  /**
   * Arm/disarm the create tools for unattended automation runs (Settings →
   * Permissions). Each automation run builds a fresh agent, so the change
   * takes effect on the next run without a session reset.
   */
  app.put(
    "/api/onoffice/automation-creates",
    { schema: { body: Type.Object({ enabled: Type.Boolean() }) } },
    async (req) => {
      await setOnOfficeAutomationCreates(req.body.enabled);
      return getOnOfficeStatus();
    },
  );

  /**
   * Arm/disarm the CRM modify/delete/send tools for chat sessions (Settings →
   * Permissions) — the onOffice counterpart of per-account email write
   * access. Live agents hold the tool list built under the old setting, so
   * flipping it resets sessions, unlike the per-run automation toggle above.
   */
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
