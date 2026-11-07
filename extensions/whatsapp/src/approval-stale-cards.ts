import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { listWhatsAppCommandOwners } from "./command-owner.js";

const log = createSubsystemLogger("whatsapp/approvals");

/** Open message cards by approval id: the session whose agent proposed the message. */
const openCards = new Map<string, { sessionKey: string; accountId?: string }>();
/** Cards this plugin closed as stale, and the outcome each shows. */
const closed = new Map<string, WhatsAppMessageCardStaleOutcome>();

/** Why a card went stale: the business answered the guest, or a newer card replaced it. */
export type WhatsAppMessageCardStaleOutcome = "answered" | "superseded";

export function trackOpenWhatsAppMessageCard(params: { request: PluginApprovalRequest }): void {
  const { sessionKey, turnSourceAccountId } = params.request.request;
  if (sessionKey) {
    openCards.set(params.request.id, {
      sessionKey,
      ...(turnSourceAccountId ? { accountId: turnSourceAccountId } : {}),
    });
  }
}

export function forgetOpenWhatsAppMessageCard(approvalId: string): void {
  openCards.delete(approvalId);
}

/** The outcome of a card this plugin closed as stale; asking clears the mark. */
export function takeStaleWhatsAppMessageCardOutcome(
  approvalId: string,
): WhatsAppMessageCardStaleOutcome | undefined {
  const outcome = closed.get(approvalId);
  closed.delete(approvalId);
  return outcome;
}

/**
 * Every open card that proposes a reply in this guest's session is stale when the business answered
 * the guest (the host typed it, or the host's agent sent it) or a card of the host's agent for the
 * same guest appeared. It is refused and shows the outcome. The owner refuses it, as the owner's
 * own reply or request made it stale.
 */
export async function closeStaleWhatsAppMessageCards(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  outcome: WhatsAppMessageCardStaleOutcome;
}): Promise<void> {
  const stale = [...openCards].filter(([, card]) => card.sessionKey === params.sessionKey);
  if (stale.length === 0) {
    return;
  }
  const owner = listWhatsAppCommandOwners(params.cfg)[0];
  if (!owner) {
    log.warn(
      `whatsapp approvals: ${stale.length} stale card(s) in ${params.sessionKey} stay open: commands.ownerAllowFrom names no WhatsApp owner`,
    );
    return;
  }
  let resolveApprovalOverGateway: typeof import("openclaw/plugin-sdk/approval-gateway-runtime").resolveApprovalOverGateway;
  try {
    ({ resolveApprovalOverGateway } = await import("openclaw/plugin-sdk/approval-gateway-runtime"));
  } catch (error) {
    log.warn(
      `whatsapp approvals: ${stale.length} stale card(s) in ${params.sessionKey} stay open: the approval resolver did not load: ${String(error)}`,
    );
    return;
  }
  for (const [approvalId, card] of stale) {
    closed.set(approvalId, params.outcome);
    try {
      await resolveApprovalOverGateway({
        cfg: params.cfg,
        approvalId,
        approvalKind: "plugin",
        decision: "deny",
        channel: "whatsapp",
        accountId: card.accountId,
        senderId: owner,
      });
    } catch (error) {
      closed.delete(approvalId);
      log.warn(
        `whatsapp approvals: stale card ${approvalId} stays open in ${params.sessionKey} (${params.outcome}): ${String(error)}`,
      );
    }
  }
}

export function clearWhatsAppMessageCardsForTest(): void {
  openCards.clear();
  closed.clear();
}
