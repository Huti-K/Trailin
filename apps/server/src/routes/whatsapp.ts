import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import type { WhatsAppStatus } from "@trailin/shared";
import { resetSessions } from "../agent/sessionCache.js";
import { getWhatsAppSendAccess, setWhatsAppSendAccess } from "../db/settings.js";
import {
  beginWhatsAppPairing,
  getWhatsAppRuntimeStatus,
  unlinkWhatsApp,
} from "../whatsapp/session.js";

async function statusPayload(): Promise<WhatsAppStatus> {
  return { ...getWhatsAppRuntimeStatus(), sendAccess: await getWhatsAppSendAccess() };
}

/**
 * The WhatsApp link (whatsapp/session.ts). Pairing is asynchronous by
 * nature: connect only opens the socket — the QR, the scan and the final
 * open state all arrive later, each announced on the "whatsapp" server-event
 * topic, so the web app refetches this status instead of long-polling.
 */
export const whatsAppRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/api/whatsapp", async () => statusPayload());

  app.post("/api/whatsapp/connect", async () => {
    await beginWhatsAppPairing();
    return statusPayload();
  });

  // Unlink also wipes the local mirror; agent sessions are rebuilt through
  // the linked-change listener (index.ts), not here.
  app.delete("/api/whatsapp", async () => {
    await unlinkWhatsApp();
    return statusPayload();
  });

  /**
   * Arm/disarm whatsapp_send_message for chat sessions (Settings →
   * Permissions) — the WhatsApp counterpart of the per-account email send
   * grant. Live agents hold the tool list built under the old setting, so
   * flipping it resets sessions.
   */
  app.put(
    "/api/whatsapp/send-access",
    { schema: { body: Type.Object({ enabled: Type.Boolean() }) } },
    async (req) => {
      await setWhatsAppSendAccess(req.body.enabled);
      await resetSessions();
      return statusPayload();
    },
  );
};
