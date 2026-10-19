import type { PluginHookChannelContext } from "openclaw/plugin-sdk/channel-inbound";
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { buildWhatsAppOwnMessageChannelContext } from "./own-message-context.js";

export function buildWhatsAppMessageChannelContext(
  msg: AdmittedWebInboundMessage,
): PluginHookChannelContext {
  const ownMessageContext = buildWhatsAppOwnMessageChannelContext(msg);
  const sender = getSenderIdentity(msg);
  const senderId = getPrimaryIdentityId(sender);
  return {
    ...ownMessageContext,
    ...(senderId
      ? { sender: { id: senderId, ...(sender.name ? { name: sender.name } : {}) } }
      : {}),
    chat: { ...ownMessageContext?.chat, receivedText: msg.payload.body },
  };
}

declare module "openclaw/plugin-sdk/channel-inbound" {
  interface PluginHookChannelSenderContext {
    name?: string;
  }
  interface PluginHookChannelChatContext {
    /** Original admitted text for this message, when a channel supplies it. */
    receivedText?: string;
  }
}
