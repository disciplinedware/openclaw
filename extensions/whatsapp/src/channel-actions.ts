import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Type } from "typebox";
import { listWhatsAppAccountIds, resolveWhatsAppAccount } from "./accounts.js";
import { resolveWhatsAppReactionLevel } from "./reaction-level.js";

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
  const actions: ChannelMessageActionName[] = ["send"];
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
    actions.push("react");
  }
  if (gate("polls")) {
    actions.push("poll");
  }
  actions.push("upload-file");
  return {
    actions,
    schema: [
      {
        properties: {
          requestApproval: Type.Optional(
            Type.Boolean({
              description:
                "Set to true when a human must approve this message before it is sent. Keep target as the intended recipient and message as the exact proposed text; do not message the approver separately. Omit for ordinary sends; a policy may still require approval. This flag does not approve delivery.",
            }),
          ),
        },
        actions: ["send"],
        visibility: "all-configured",
      },
    ],
  };
}
