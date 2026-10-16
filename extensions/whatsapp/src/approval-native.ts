import { createApproverRestrictedNativeApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  createNativeApprovalMessagingTargetResolvers,
} from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalReactionPromptPayloadForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import { buildTypedApprovalPresentation } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listWhatsAppAccountIds } from "./accounts.js";
import {
  getWhatsAppExecApprovalApprovers,
  isWhatsAppExecApprovalApprover,
  isWhatsAppExecApprovalAuthorizedSender,
  isWhatsAppExecApprovalClientEnabled,
  isWhatsAppExecApprovalTargetRecipient,
  resolveWhatsAppExecApprovalTarget,
  shouldHandleWhatsAppExecApprovalRequest,
  shouldNotifyWhatsAppApprovalOrigin,
} from "./exec-approvals.js";
import { normalizeWhatsAppMessagingTarget } from "./normalize-target.js";

const whatsappMessagingTargets = createNativeApprovalMessagingTargetResolvers({
  channel: "whatsapp",
  normalizeTo: normalizeWhatsAppMessagingTarget,
});

const resolveWhatsAppOriginTarget = createChannelNativeOriginTargetResolver({
  channel: "whatsapp",
  shouldHandleRequest: shouldHandleWhatsAppExecApprovalRequest,
  resolveTurnSourceTarget: whatsappMessagingTargets.resolveTurnSourceTarget,
  resolveSessionTarget: whatsappMessagingTargets.resolveSessionTarget,
  normalizeTarget: whatsappMessagingTargets.normalizeTarget,
});

const resolveWhatsAppApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleWhatsAppExecApprovalRequest,
  resolveApprovers: getWhatsAppExecApprovalApprovers,
  mapApprover: (approver) => ({ to: approver }),
});

function describeWhatsAppApprovalSetup(
  { accountId }: { accountId?: string | null },
  approvalKind: ChannelApprovalKind,
): string {
  const prefix =
    accountId && accountId !== "default"
      ? `channels.whatsapp.accounts.${accountId}`
      : "channels.whatsapp";
  return `Approve it from the ${approvalKind === "plugin" ? "Web UI or terminal UI" : "Web UI"} for now. WhatsApp supports native ${approvalKind} approvals for this account. Configure \`${prefix}.execApprovals.approvers\` or \`commands.ownerAllowFrom\`; leave \`${prefix}.execApprovals.enabled\` unset/\`auto\` or set it to \`true\`.`;
}

const whatsappNativeApprovalCapability = createApproverRestrictedNativeApprovalCapability({
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  describeExecApprovalSetup: (params) => describeWhatsAppApprovalSetup(params, "exec"),
  describePluginApprovalSetup: (params) => describeWhatsAppApprovalSetup(params, "plugin"),
  listAccountIds: listWhatsAppAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getWhatsAppExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: isWhatsAppExecApprovalAuthorizedSender,
  isPluginAuthorizedSender: isWhatsAppExecApprovalApprover,
  isNativeDeliveryEnabled: isWhatsAppExecApprovalClientEnabled,
  resolveNativeDeliveryMode: resolveWhatsAppExecApprovalTarget,
  requireMatchingTurnSourceChannel: true,
  resolveSuppressionAccountId: ({ target, request }) =>
    normalizeOptionalString(target.accountId) ??
    normalizeOptionalString(request.request.turnSourceAccountId),
  resolveOriginTarget: resolveWhatsAppOriginTarget,
  resolveApproverDmTargets: resolveWhatsAppApproverDmTargets,
  nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
    capabilityBoundary: true,
    eventKinds: ["exec", "plugin", "system-agent"],
    isConfigured: ({ cfg, accountId, context }) =>
      Boolean(context) && isWhatsAppExecApprovalClientEnabled({ cfg, accountId }),
    shouldHandle: ({ cfg, accountId, context, request }) =>
      Boolean(context) && shouldHandleWhatsAppExecApprovalRequest({ cfg, accountId, request }),
    load: async () => (await import("./approval-handler.runtime.js")).whatsappApprovalNativeRuntime,
  }),
});

const resolveWhatsAppApproveCommandBehavior: NonNullable<
  ChannelApprovalCapability["resolveApproveCommandBehavior"]
> = (params) => {
  if (
    params.approvalKind !== "exec" ||
    isWhatsAppExecApprovalClientEnabled(params) ||
    isWhatsAppExecApprovalTargetRecipient(params) ||
    (isWhatsAppExecApprovalAuthorizedSender(params) && !isWhatsAppExecApprovalApprover(params))
  ) {
    return undefined;
  }
  return {
    kind: "reply",
    text: "❌ WhatsApp exec approvals are not enabled for this account.",
  };
};

function buildWhatsAppPendingPayload(
  params: { request: ExecApprovalRequest | PluginApprovalRequest; nowMs: number },
  approvalKind: ChannelApprovalKind,
) {
  const payload = buildApprovalReactionPromptPayloadForRequest(params);
  return {
    ...payload,
    presentation: buildTypedApprovalPresentation({
      approvalId: params.request.id,
      approvalKind,
      allowedDecisions: payload.allowedDecisions,
    }),
  };
}

// The builder takes notifyOriginWhenDmOnly as one constant; WhatsApp reads it per account
// (execApprovals.notifyOrigin), because a business's origin chat is a customer's.
function withPerAccountOriginNotice(
  native: ChannelApprovalCapability["native"],
): ChannelApprovalCapability["native"] {
  return (
    native && {
      ...native,
      describeDeliveryCapabilities: (params) => ({
        ...native.describeDeliveryCapabilities(params),
        notifyOriginWhenDmOnly: shouldNotifyWhatsAppApprovalOrigin(params),
      }),
    }
  );
}

export const whatsappApprovalCapability: ChannelApprovalCapability = {
  ...whatsappNativeApprovalCapability,
  native: withPerAccountOriginNotice(whatsappNativeApprovalCapability.native),
  resolveApproveCommandBehavior: resolveWhatsAppApproveCommandBehavior,
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildWhatsAppPendingPayload({ request, nowMs }, "exec"),
    },
    plugin: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildWhatsAppPendingPayload({ request, nowMs }, "plugin"),
    },
  },
};
