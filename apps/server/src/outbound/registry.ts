import type { OutboundDraft } from "./store.js";

/**
 * Send registry for outbound comm channels, mirroring the email DraftProvider
 * registry: a channel registers how to dispatch an approved draft and whether
 * autosend is armed in Settings. Registration lives in registerChannels.ts.
 */

export interface OutboundChannel {
  label: string;
  /** The Settings send permission for this channel. */
  isArmed(): Promise<boolean>;
  send(draft: OutboundDraft): Promise<{ sentRef?: string }>;
}

const registry = new Map<string, OutboundChannel>();

export function registerOutboundChannel(channel: string, impl: OutboundChannel): void {
  registry.set(channel, impl);
}

export function getOutboundChannel(channel: string): OutboundChannel | null {
  return registry.get(channel) ?? null;
}
