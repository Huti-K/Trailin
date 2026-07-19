/**
 * Socket state: "off" (no socket: never paired, pairing expired, or unlinked),
 * "pairing" (QR flow active), "connecting" (paired, dialing), "open".
 */
export type WhatsAppConnection = "off" | "pairing" | "connecting" | "open";

export interface WhatsAppStatus {
  /** Paired (credentials exist), connected or not. */
  linked: boolean;
  connection: WhatsAppConnection;
  qrDataUrl: string | null;
  phoneNumber: string | null;
  pushName: string | null;
  sendAccess: boolean;
}
