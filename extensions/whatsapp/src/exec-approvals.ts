import { resolveApprovalApprovers } from "openclaw/plugin-sdk/approval-auth-runtime";
import {
  createChannelExecApprovalProfile,
  isChannelExecApprovalClientEnabledFromConfig,
  isChannelExecApprovalTargetRecipient,
  matchesApprovalRequestFilters,
} from "openclaw/plugin-sdk/approval-client-runtime";
import { doesApprovalRequestSelectChannelAccount } from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { resolveDefaultWhatsAppAccountId, resolveWhatsAppAccount } from "./accounts.js";
import { listWhatsAppCommandOwners, normalizeWhatsAppDirectId } from "./command-owner.js";

type WhatsAppExecApprovalConfig = NonNullable<WhatsAppAccountConfig["execApprovals"]>;
type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest;

function resolveWhatsAppExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): WhatsAppExecApprovalConfig {
  const account = resolveWhatsAppAccount(params);
  const config = account.execApprovals;
  return {
    ...config,
    enabled: account.enabled ? (config?.enabled ?? "auto") : false,
  };
}

/** Whether the originating chat hears that its approval went to approver DMs. */
export function shouldNotifyWhatsAppApprovalOrigin(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppExecApprovalConfig(params).notifyOrigin !== false;
}

/** `execApprovals.approvers`, else the WhatsApp owners in `commands.ownerAllowFrom`. Never `allowFrom`. */
export function getWhatsAppExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveApprovalApprovers({
    explicit: resolveWhatsAppExecApprovalConfig(params).approvers,
    allowFrom: listWhatsAppCommandOwners(params.cfg),
    normalizeApprover: normalizeWhatsAppDirectId,
  });
}

export function isWhatsAppExecApprovalTargetRecipient(params: {
  cfg: OpenClawConfig;
  senderId?: string | null;
  accountId?: string | null;
}): boolean {
  return isChannelExecApprovalTargetRecipient({
    ...params,
    channel: "whatsapp",
    normalizeSenderId: normalizeWhatsAppDirectId,
    matchTarget: ({ target, normalizedSenderId }) =>
      normalizeWhatsAppDirectId(target.to) === normalizedSenderId,
  });
}

function isWhatsAppExecApprovalAccountEligible(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ApprovalRequest;
}): boolean {
  if (!resolveWhatsAppAccount(params).enabled) {
    return false;
  }
  const config = resolveWhatsAppExecApprovalConfig(params);
  return (
    isChannelExecApprovalClientEnabledFromConfig({
      enabled: config.enabled,
      approverCount: getWhatsAppExecApprovalApprovers(params).length,
    }) &&
    matchesApprovalRequestFilters({
      request: params.request.request,
      agentFilter: config.agentFilter,
      sessionFilter: config.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  );
}

function matchesWhatsAppRequestAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  const defaultAccountId = resolveDefaultWhatsAppAccountId(params.cfg);
  const accountId = params.accountId ?? defaultAccountId;
  return doesApprovalRequestSelectChannelAccount({
    ...params,
    channel: "whatsapp",
    defaultAccountId,
    eligibleAccountIds: isWhatsAppExecApprovalAccountEligible({ ...params, accountId })
      ? [accountId]
      : [],
  });
}

const whatsappExecApprovalProfile = createChannelExecApprovalProfile({
  resolveConfig: resolveWhatsAppExecApprovalConfig,
  resolveApprovers: getWhatsAppExecApprovalApprovers,
  normalizeSenderId: normalizeWhatsAppDirectId,
  isTargetRecipient: isWhatsAppExecApprovalTargetRecipient,
  matchesRequestAccount: matchesWhatsAppRequestAccount,
  fallbackAgentIdFromSessionKey: true,
  requireClientEnabledForLocalPromptSuppression: false,
});

export const isWhatsAppExecApprovalClientEnabled = whatsappExecApprovalProfile.isClientEnabled;
export const isWhatsAppExecApprovalApprover = whatsappExecApprovalProfile.isApprover;
export const isWhatsAppExecApprovalAuthorizedSender =
  whatsappExecApprovalProfile.isAuthorizedSender;
export const resolveWhatsAppExecApprovalTarget = whatsappExecApprovalProfile.resolveTarget;
export const shouldHandleWhatsAppExecApprovalRequest =
  whatsappExecApprovalProfile.shouldHandleRequest;
