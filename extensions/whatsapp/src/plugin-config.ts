import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";

/**
 * `plugins.entries.whatsapp-for-business.config`, which OpenClaw validates against
 * `configSchema` in openclaw.plugin.json at startup. The plugin's settings live here, not in
 * `channels.whatsapp`, whose schema belongs to OpenClaw's core.
 */
export type WhatsAppPluginConfig = {
  blockOverdueAnswers?: boolean;
  approvalLanguage?: "en" | "es";
  approvalUnansweredMessageLimit?: number;
  unhandledApprovalPolicy?: "block" | "send";
  execApprovals?: {
    enabled?: boolean | "auto";
    approvers?: string[];
    agentFilter?: string[];
    sessionFilter?: string[];
    target?: "dm" | "channel" | "both";
    notifyOrigin?: boolean;
  };
  ownMessages?: "off" | "history" | "turn";
  historyAuthors?: { phone?: string; ownerAgent?: string; approval?: string };
};

export function readWhatsAppPluginConfig(cfg: OpenClawConfig | undefined): WhatsAppPluginConfig {
  return (cfg?.plugins?.entries?.[WHATSAPP_FOR_BUSINESS_PLUGIN_ID]?.config ??
    {}) as WhatsAppPluginConfig;
}
