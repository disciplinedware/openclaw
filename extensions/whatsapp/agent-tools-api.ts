// WhatsApp agent facade (tools, agent send history, overdue-answer send guard) keeps the bundled entrypoint light during discovery.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerWhatsAppAgentSendHistory } from "./src/agent-send-history.js";
import { registerWhatsAppCallTool } from "./src/agent-tools-call.js";
import { registerWhatsAppLoginTool } from "./src/agent-tools-login.js";
import { registerWhatsAppApprovalDelivery } from "./src/approval-delivery.js";
import { registerWhatsAppOverdueAnswerSendGuard } from "./src/overdue-answer-send-guard.js";
import { registerWhatsAppOwnMessageHistory } from "./src/own-message-history.js";

export function registerWhatsAppAgentTools(api: OpenClawPluginApi): void {
  registerWhatsAppCallTool(api);
  registerWhatsAppLoginTool(api);
}

export {
  registerWhatsAppAgentSendHistory,
  registerWhatsAppApprovalDelivery,
  registerWhatsAppOverdueAnswerSendGuard,
  registerWhatsAppOwnMessageHistory,
};
