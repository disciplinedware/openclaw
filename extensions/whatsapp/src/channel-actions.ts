import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { Type } from "typebox";
import { listWhatsAppAccountIds, resolveWhatsAppAccount } from "./accounts.js";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";

function unhandledApprovalPolicy(): "block" | "send" {
  const configured =
    getRuntimeConfig().plugins?.entries?.[WHATSAPP_FOR_BUSINESS_PLUGIN_ID]?.config
      ?.unhandledApprovalPolicy;
  return configured === "send" ? "send" : "block";
}

export const prepareWhatsAppSendPayload: NonNullable<
  ChannelMessageActionAdapter["prepareSendPayload"]
> = ({ ctx, payload }) => {
  const requestApproval = ctx.params.requestApproval;
  if (requestApproval !== undefined && typeof requestApproval !== "boolean") {
    throw new Error("WhatsApp requestApproval must be a boolean.");
  }
  if (requestApproval !== true || unhandledApprovalPolicy() === "send") {
    return payload;
  }
  throw new Error(
    "This WhatsApp send requested approval, but the configured approval policy did not process it.",
  );
};

function resolveEnabledWhatsAppAgentReactions(params: { cfg: OpenClawConfig; accountId?: string }) {
  if (!params.cfg.channels?.whatsapp) {
    return undefined;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  if (!gate("reactions")) {
    return undefined;
  }
  const resolved = resolveWhatsAppReactionLevel({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  return resolved.agentReactionsEnabled ? resolved : undefined;
}

export function resolveWhatsAppAgentReactionGuidance(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  return resolveEnabledWhatsAppAgentReactions(params)?.agentReactionGuidance;
}

function hasAnyWhatsAppAccountWithAgentReactionsEnabled(cfg: OpenClawConfig) {
  if (!cfg.channels?.whatsapp) {
    return false;
  }
  return listWhatsAppAccountIds(cfg).some((accountId) => {
    const account = resolveWhatsAppAccount({ cfg, accountId });
    if (!account.enabled) {
      return false;
    }
    return Boolean(
      resolveEnabledWhatsAppAgentReactions({
        cfg,
        accountId,
      }),
    );
  });
}

export function describeWhatsAppMessageActions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ChannelMessageToolDiscovery | null {
  if (!params.cfg.channels?.whatsapp) {
    return null;
  }
  const gate = createActionGate(params.cfg.channels.whatsapp.actions);
  const actions = new Set<ChannelMessageActionName>();
  const canReact =
    params.accountId != null
      ? Boolean(
          resolveEnabledWhatsAppAgentReactions({
            cfg: params.cfg,
            accountId: params.accountId,
          }),
        )
      : hasAnyWhatsAppAccountWithAgentReactionsEnabled(params.cfg);
  if (canReact) {
    actions.add("react");
  }
  if (gate("polls")) {
    actions.add("poll");
  }
  actions.add("upload-file");
  return {
    actions: Array.from(actions),
    schema: [
      {
        properties: {
          requestApproval: Type.Optional(
            Type.Boolean({
              description:
                "Set to true when a human must approve this message. Calling send with true submits the proposed reply to the configured approval handler. When requesting review, put the proposed reply in this call instead of messaging the approver separately. Keep target as the intended recipient and message as the exact proposed reply. Omit for ordinary sends; a policy may still require approval. This flag does not approve delivery.",
            }),
          ),
        },
        actions: ["send"],
        visibility: "all-configured",
      },
      {
        properties: {
          replyContext: Type.Optional(
            Type.String({
              description:
                "Brief context for this reply: summarize the relevant incoming request and unresolved questions. Supply this with a proposed external message or reaction, even when requestApproval is omitted: a policy may require approval. Keep the exact operation in its action arguments: message for send, emoji and messageId for react. This context is metadata, not a quotation, permission or text to send. It must be a nonempty string when approval is required. If the tool asks for missing or shorter context, correct this field and repeat the same proposed operation. Ordinary replies to the operator do not need replyContext when policy permits them.",
            }),
          ),
        },
        actions: ["send", "react"],
        visibility: "all-configured",
      },
    ],
  };
}
