import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { listWhatsAppCommandOwners } from "./command-owner.js";

const log = createSubsystemLogger("whatsapp/approvals");

/** Open message cards by approval id: the session whose agent proposed the message. */
const openCards = new Map<string, { sessionKey: string; accountId?: string }>();
/** Cards this plugin closed because the business answered the same guest. */
const answered = new Set<string>();

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

/** Whether this plugin closed the card for a business reply; asking clears the mark. */
export function takeWhatsAppMessageCardAnswered(approvalId: string): boolean {
  return answered.delete(approvalId);
}

/**
 * The business answered a guest (the host typed it, or the host's agent sent it): every open card
 * that proposes a reply in that guest's session is stale, so it is refused and shows "answered".
 * The owner refuses it, as the owner's own reply made it stale.
 */
export async function closeWhatsAppMessageCardsAnsweredByBusiness(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
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
    answered.add(approvalId);
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
      answered.delete(approvalId);
      log.warn(
        `whatsapp approvals: card ${approvalId} stays open after a business reply in ${params.sessionKey}: ${String(error)}`,
      );
    }
  }
}

export function clearWhatsAppMessageCardsForTest(): void {
  openCards.clear();
  answered.clear();
}
