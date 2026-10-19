import type { PluginHookChannelContext } from "openclaw/plugin-sdk/channel-inbound";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { WhatsAppOwnMessageTurnFacts } from "../../own-messages.js";

/** What hooks read on an owner turn: `channelContext.chat.ownMessage`. */
export function buildWhatsAppOwnMessageChannelContext(
  msg: AdmittedWebInboundMessage,
): PluginHookChannelContext | undefined {
  return msg.ownMessage ? { chat: { ownMessage: { ...msg.ownMessage } } } : undefined;
}

declare module "openclaw/plugin-sdk/channel-inbound" {
  interface PluginHookChannelChatContext {
    /** Set by this plugin alone, on an owner turn. */
    ownMessage?: WhatsAppOwnMessageTurnFacts;
  }
}
