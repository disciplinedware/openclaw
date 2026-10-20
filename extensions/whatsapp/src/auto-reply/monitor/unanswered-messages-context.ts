import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { WhatsAppUnansweredMessage } from "../../overdue-answers.js";

/**
 * Adds the person's messages that no delivered message answered to the turn's channel structured
 * context, when there are several: under queue mode `interrupt` a new message cancels the turn and
 * its proposal for the earlier ones, so this turn answers them all.
 */
export function withWhatsAppUnansweredMessagesContext(
  msg: AdmittedWebInboundMessage,
  unanswered: WhatsAppUnansweredMessage[],
): AdmittedWebInboundMessage {
  if (unanswered.length < 2) {
    return msg;
  }
  const entry = {
    label: "WhatsApp messages without an answer",
    source: "whatsapp",
    type: "unanswered_messages",
    payload: {
      messages: unanswered.map((message) => ({
        sent_at: message.sentAtMs !== undefined ? new Date(message.sentAtMs).toISOString() : null,
        text: message.text ?? null,
      })),
      rule: "No message from this WhatsApp number reached the person after these messages, so nothing proposed for them was delivered. Answer all of them in one reply.",
    },
  };
  return {
    ...msg,
    payload: {
      ...msg.payload,
      channelStructuredContext: [...(msg.payload.channelStructuredContext ?? []), entry],
    },
  };
}
