import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { recordWhatsAppAssistantMessageHistory } from "./own-message-history.js";

const log = createSubsystemLogger("whatsapp/approvals");

export type WhatsAppApprovalMessage = {
  accountId: string;
  to: string;
  remoteJid: string;
  messageId: string;
  text: string;
  sourceSessionKey?: string;
  recipientSessionKeys?: string[];
  deliveryKey?: string;
};

export async function recordWhatsAppApprovalHistory(
  entry: WhatsAppApprovalMessage,
  text: string,
  messageId: string,
): Promise<void> {
  const context = [
    entry.sourceSessionKey ? `[Source conversation: ${entry.sourceSessionKey}]` : undefined,
    ...new Set(entry.recipientSessionKeys?.map((key) => `[Recipient conversation: ${key}]`)),
  ].filter(Boolean);
  try {
    await recordWhatsAppAssistantMessageHistory({
      accountId: entry.accountId,
      peerE164: entry.to,
      messageId,
      timestampMs: Date.now(),
      text: [text, ...context].join("\n\n"),
      source: "whatsapp_system",
    });
  } catch (error) {
    log.error(
      `whatsapp approvals: failed to record delivered message ${messageId}: ${String(error)}`,
    );
  }
}
