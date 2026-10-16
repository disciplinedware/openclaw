import type { PluginHookChannelContext } from "openclaw/plugin-sdk/channel-inbound";
import type { ResolvedWhatsAppAccount } from "../../accounts.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  deleteWhatsAppOwnMessageHistory,
  listWhatsAppOwnMessageHistory,
} from "../../own-message-history.js";
import {
  type WhatsAppOwnMessageTurnFacts,
  formatWhatsAppOwnMessageContent,
  resolveWhatsAppOwnMessagesMode,
  WHATSAPP_ASSISTANT_MESSAGE_MARKER,
  WHATSAPP_OWN_MESSAGE_SENDER_LABEL,
} from "../../own-messages.js";
import type { GroupHistoryEntry } from "./inbound-context.js";

export type WhatsAppOwnMessageHistory = {
  /** The newest `limit` pending messages, shown to the turn. */
  entries: GroupHistoryEntry[];
  /** Every pending message of the chat, consumed when the turn is dispatched. */
  keys: string[];
};

/**
 * Messages the account sent to this direct chat since its last dispatched turn, oldest first:
 * typed on the phone (`ownMessages`) or sent by the assistant from another session.
 */
export async function loadWhatsAppOwnMessageHistory(params: {
  account: ResolvedWhatsAppAccount;
  msg: AdmittedWebInboundMessage;
  conversationKind: "direct" | "group";
  peerE164?: string;
  limit: number;
}): Promise<WhatsAppOwnMessageHistory | undefined> {
  if (
    params.limit <= 0 ||
    params.conversationKind !== "direct" ||
    params.msg.ownMessage ||
    !params.peerE164
  ) {
    return undefined;
  }
  const pending = await listWhatsAppOwnMessageHistory({
    accountId: params.account.accountId,
    peerE164: params.peerE164,
  });
  if (pending.length === 0) {
    return undefined;
  }
  // With ownMessages off, messages typed on the phone and stored before the switch never reach
  // the model; the turn still consumes them.
  const shown =
    resolveWhatsAppOwnMessagesMode(params.account) === "off"
      ? pending.filter(({ message }) => message.author === "assistant")
      : pending;
  // The turn shows the newest `limit` messages and consumes all of them: an older message
  // left behind would come back in a later turn as if it were new.
  return {
    entries: shown.slice(-params.limit).map(({ message }) => ({
      sender: WHATSAPP_OWN_MESSAGE_SENDER_LABEL,
      body:
        message.author === "assistant"
          ? `${WHATSAPP_ASSISTANT_MESSAGE_MARKER} ${formatWhatsAppOwnMessageContent(message)}`
          : formatWhatsAppOwnMessageContent(message),
      timestamp: message.timestampMs,
      id: message.messageId,
    })),
    keys: pending.map(({ key }) => key),
  };
}

/** Called once the turn that carried the history is dispatched into its session. */
export async function consumeWhatsAppOwnMessageHistory(
  history: WhatsAppOwnMessageHistory,
): Promise<void> {
  await deleteWhatsAppOwnMessageHistory(history.keys);
}

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
