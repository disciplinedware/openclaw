import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  describeWhatsAppOverdueAnswerRule,
  isWhatsAppOverdueAnswerBlockingEnabled,
} from "../../overdue-answers.js";

/**
 * Adds the current overdue-answer policy to the turn's channel structured context.
 */
export function withWhatsAppOverdueAnswerContext(
  msg: AdmittedWebInboundMessage,
): AdmittedWebInboundMessage {
  if (!isWhatsAppOverdueAnswerBlockingEnabled()) {
    const entry = {
      label: "WhatsApp overdue-answer policy",
      source: "whatsapp",
      type: "overdue_answer_policy",
      payload: {
        rule: "The WhatsApp plugin's overdue refusal is disabled for this turn. An old overdue refusal does not establish current permission. Other policies and approval requirements still apply.",
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

  const overdue = msg.overdueAnswer;
  if (!overdue) {
    return msg;
  }
  const entry = {
    label: "WhatsApp overdue answer",
    source: "whatsapp",
    type: "overdue_answer",
    payload: {
      earliest_unanswered_message_sent_at:
        overdue.earliestSentAtMs !== undefined
          ? new Date(overdue.earliestSentAtMs).toISOString()
          : null,
      can_write_to: "owner",
      rule: describeWhatsAppOverdueAnswerRule(overdue),
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
