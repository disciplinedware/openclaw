// WhatsApp agent facade (tools, agent send history, overdue-answer send guard, cancelled proposals) keeps the bundled entrypoint light during discovery.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerWhatsAppAgentSendHistory } from "./src/agent-send-history.js";
import { registerWhatsAppCallTool } from "./src/agent-tools-call.js";
import { registerWhatsAppLoginTool } from "./src/agent-tools-login.js";
import { registerWhatsAppApprovalDelivery } from "./src/approval-delivery.js";
import { registerWhatsAppCancelledProposalsContext } from "./src/cancelled-proposals-context.js";
import { registerWhatsAppOverdueAnswerSendGuard } from "./src/overdue-answer-send-guard.js";
import { registerWhatsAppOwnMessageHistory } from "./src/own-message-history.js";

export function registerWhatsAppAgentTools(api: OpenClawPluginApi): void {
  registerWhatsAppCallTool(api);
  registerWhatsAppLoginTool(api);
}

export {
  registerWhatsAppAgentSendHistory,
  registerWhatsAppApprovalDelivery,
  registerWhatsAppCancelledProposalsContext,
  registerWhatsAppOverdueAnswerSendGuard,
  registerWhatsAppOwnMessageHistory,
};
