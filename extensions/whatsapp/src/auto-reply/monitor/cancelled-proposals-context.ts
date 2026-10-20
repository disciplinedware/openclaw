import type { WhatsAppCancelledProposal } from "../../approval-cards.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";

/**
 * Adds the session's proposals that a new message cancelled before the approver decided to the
 * turn's channel structured context: under queue mode `interrupt` the turn sees only that its tool
 * call was interrupted, with an unknown outcome, and nothing of them was sent.
 */
export function withWhatsAppCancelledProposalsContext(
  msg: AdmittedWebInboundMessage,
  proposals: readonly WhatsAppCancelledProposal[],
): AdmittedWebInboundMessage {
  if (proposals.length === 0) {
    return msg;
  }
  const entry = {
    label: "WhatsApp proposals cancelled before a decision",
    source: "whatsapp",
    type: "cancelled_proposals",
    payload: {
      proposals: proposals.map((proposal) => ({
        recipients: proposal.recipients,
        cancelled_at: new Date(proposal.cancelledAtMs).toISOString(),
        card: proposal.description ?? null,
      })),
      rule: "A new message cancelled these proposals before the approver decided, so none was sent. Propose again each one that the conversation still asks for, together with the answer to the new message.",
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
