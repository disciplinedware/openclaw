import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  buildChannelApprovalExpiredText,
  buildChannelApprovalResolvedText,
  createChannelApprovalNativeRuntimeAdapter,
  resolvePreparedApprovalAccountId,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  buildApprovalReactionPendingContent,
  type ApprovalReactionPendingContent,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";
import { getActiveWebListener } from "./active-listener.js";
import {
  forgetWhatsAppApprovalDelivery,
  noteWhatsAppApprovalAllowSubmitted,
  rememberWhatsAppApprovalDelivery,
} from "./approval-delivery.js";
import { recordWhatsAppApprovalHistory, type WhatsAppApprovalMessage } from "./approval-history.js";
import {
  registerWhatsAppApprovalReactionTarget,
  unregisterWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  buildWhatsAppPluginApprovalOutcomeText,
  buildWhatsAppPluginApprovalText,
} from "./approval-text.js";
import { normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget } from "./normalize-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { editMessageWhatsApp, sendMessageWhatsApp, sendTypingWhatsApp } from "./send.js";
import { resolveWhatsAppDirectSessionKey } from "./session-route.js";

const log = createSubsystemLogger("whatsapp/approvals");

type PreparedWhatsAppApprovalTarget = {
  to: string;
  accountId: string;
};
type WhatsAppFinalPayload = {
  text: string;
  deliveryPending?: boolean;
};

export const whatsappApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  ApprovalReactionPendingContent,
  PreparedWhatsAppApprovalTarget,
  WhatsAppApprovalMessage,
  true,
  WhatsAppFinalPayload
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: (params) => {
      const content = buildApprovalReactionPendingContent(params);
      if (params.view.approvalKind !== "plugin") {
        return content;
      }
      return {
        ...content,
        reactionPayload: {
          ...content.reactionPayload,
          text: buildWhatsAppPluginApprovalText({
            title: params.view.title,
            description: params.view.description,
            allowedDecisions: content.reactionPayload.allowedDecisions,
            expiresAtMs: params.view.expiresAtMs,
            nowMs: params.nowMs,
          }),
        },
      };
    },
    buildResolvedResult: ({ request, resolved, view }) => ({
      kind: "update",
      payload: {
        deliveryPending: resolved.decision === "allow-once" || resolved.decision === "allow-always",
        text:
          view.approvalKind === "plugin"
            ? [
                buildWhatsAppPluginApprovalOutcomeText(resolved.decision),
                resolved.decision === "deny" ? undefined : view.description,
              ]
                .filter(Boolean)
                .join("\n\n")
            : buildChannelApprovalResolvedText({ request, resolved, view }),
      },
    }),
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload: {
        text:
          view.approvalKind === "plugin"
            ? buildWhatsAppPluginApprovalOutcomeText("expired")
            : buildChannelApprovalExpiredText({ request, view }),
      },
    }),
  },
  transport: {
    prepareTarget: ({ cfg, plannedTarget, accountId }) => {
      const to = normalizeWhatsAppMessagingTarget(plannedTarget.target.to);
      if (!to) {
        return null;
      }
      const prepared: PreparedWhatsAppApprovalTarget = {
        to,
        accountId: resolvePreparedApprovalAccountId({
          plannedAccountId: (plannedTarget.target as { accountId?: string | null }).accountId,
          contextAccountId: accountId,
          fallbackAccountId: cfg ? resolveDefaultWhatsAppAccountId(cfg) : DEFAULT_ACCOUNT_ID,
        }),
      };
      return {
        dedupeKey: `${prepared.accountId ?? ""}:${buildChannelApprovalNativeTargetKey({
          to: prepared.to,
        })}`,
        target: prepared,
      };
    },
    deliverPending: async ({ cfg, preparedTarget, pendingPayload, request }) => {
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      await sendTypingWhatsApp(preparedTarget.to, {
        cfg,
        accountId: preparedTarget.accountId,
      }).catch(() => {});
      const text = pendingPayload.reactionPayload.text ?? "";
      const result = await sendMessageWhatsApp(preparedTarget.to, text, {
        cfg,
        verbose,
        accountId: preparedTarget.accountId,
        preserveLeadingWhitespace: true,
      });
      if (!result.messageId) {
        return null;
      }
      const sourceSessionKey =
        "sessionKey" in request.request ? request.request.sessionKey?.trim() : undefined;
      const entry: WhatsAppApprovalMessage = {
        accountId: preparedTarget.accountId,
        to: preparedTarget.to,
        remoteJid: result.toJid,
        messageId: result.messageId,
        text,
        ...(sourceSessionKey ? { sourceSessionKey } : {}),
      };
      if (
        "scope" in request.request &&
        request.request.scope?.kind === "message-send" &&
        request.request.scope.target === "whatsapp"
      ) {
        const recipients = getActiveWebListener(entry.accountId)?.recipients;
        const recipientSessionKeys: string[] = [];
        for (const recipient of request.request.scope.recipients ?? []) {
          const normalized = normalizeWhatsAppTarget(recipient);
          if (!normalized?.startsWith("+")) {
            continue;
          }
          const peerE164 = recipients ? await recipients.resolveE164(normalized) : normalized;
          recipientSessionKeys.push(
            resolveWhatsAppDirectSessionKey({ cfg, accountId: entry.accountId, peerE164 }),
          );
        }
        entry.recipientSessionKeys = recipientSessionKeys;
      }
      await recordWhatsAppApprovalHistory(entry, text, result.messageId);
      if ("title" in request.request) {
        await rememberWhatsAppApprovalDelivery(request.request, entry);
      }
      return entry;
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      if (payload.deliveryPending) {
        noteWhatsAppApprovalAllowSubmitted(entry);
      } else {
        await forgetWhatsAppApprovalDelivery(entry);
      }
      try {
        await editMessageWhatsApp(entry.remoteJid, entry.messageId, payload.text, {
          cfg,
          accountId: entry.accountId,
        });
        await recordWhatsAppApprovalHistory(entry, payload.text, `${entry.messageId}:outcome`);
        return;
      } catch (error) {
        log.error(
          `whatsapp approvals: failed to update prompt ${entry.messageId}: ${String(error)}`,
        );
      }
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      const result = await sendMessageWhatsApp(entry.to, payload.text, {
        cfg,
        verbose,
        accountId: entry.accountId,
        preserveLeadingWhitespace: true,
        quotedMessageKey: {
          id: entry.messageId,
          remoteJid: entry.remoteJid,
          fromMe: true,
          messageText: entry.text,
        },
      });
      await recordWhatsAppApprovalHistory(entry, payload.text, result.messageId);
    },
  },
  interactions: {
    bindPending: async ({ entry, request, view, pendingPayload }) =>
      (await registerWhatsAppApprovalReactionTarget({
        accountId: entry.accountId,
        remoteJid: entry.remoteJid,
        messageId: entry.messageId,
        approvalId: request.id,
        approvalKind: view.approvalKind,
        allowedDecisions: pendingPayload.reactionPayload.allowedDecisions,
        ttlMs: Math.max(1, view.expiresAtMs - Date.now()),
      }))
        ? true
        : null,
    unbindPending: ({ entry }) => unregisterWhatsAppApprovalReactionTarget(entry),
    cancelDelivered: ({ entry }) => unregisterWhatsAppApprovalReactionTarget(entry),
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`whatsapp approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
