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
import type { ApprovalScope } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";
import { getActiveWebListener } from "./active-listener.js";
import {
  consumeWhatsAppApprovalReactionDecision,
  recordWhatsAppApprovalCardClosed,
  recordWhatsAppApprovalCardDeclined,
  recordWhatsAppApprovalCardDelivered,
  consumeWhatsAppApprovalCardsReplacedBy,
  type WhatsAppApprovalCard,
} from "./approval-cards.js";
import {
  forgetWhatsAppApprovalDelivery,
  rememberWhatsAppApprovalDelivery,
} from "./approval-delivery.js";
import { recordWhatsAppApprovalHistory, type WhatsAppApprovalMessage } from "./approval-history.js";
import {
  registerWhatsAppApprovalReactionTarget,
  unregisterWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  buildWhatsAppApprovalReminderText,
  buildWhatsAppApprovalUnansweredMessagesText,
  buildWhatsAppPluginApprovalOutcomeText,
  buildWhatsAppPluginApprovalText,
  type WhatsAppApprovalRecipientMessages,
  type WhatsAppPluginApprovalOutcome,
} from "./approval-text.js";
import { normalizeWhatsAppMessagingTarget, normalizeWhatsAppTarget } from "./normalize-target.js";
import { readWhatsAppUnansweredMessages } from "./overdue-answers.js";
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
  /** How a plugin approval ended; absent for exec and system approvals. */
  outcome?: WhatsAppPluginApprovalOutcome;
};

/** The E.164 numbers a WhatsApp message approval sends to; undefined for any other approval. */
async function resolveWhatsAppMessageRecipients(
  scope: ApprovalScope | null | undefined,
  accountId: string,
): Promise<string[] | undefined> {
  if (scope?.kind !== "message-send" || scope.target !== "whatsapp") {
    return undefined;
  }
  const listener = getActiveWebListener(accountId)?.recipients;
  const recipients: string[] = [];
  for (const recipient of scope.recipients ?? []) {
    const normalized = normalizeWhatsAppTarget(recipient);
    if (!normalized?.startsWith("+")) {
      continue;
    }
    // The number WhatsApp keeps the chat under: a Mexican mobile number has two written forms.
    recipients.push(listener ? await listener.resolveE164(normalized) : normalized);
  }
  return [...new Set(recipients)];
}

async function readRecipientMessages(
  recipients: readonly string[] | undefined,
  accountId: string,
): Promise<WhatsAppApprovalRecipientMessages[]> {
  return await Promise.all(
    (recipients ?? []).map(async (personE164) => ({
      personE164,
      messages: await readWhatsAppUnansweredMessages({ accountId, personE164 }),
    })),
  );
}

/** Marks the cancelled cards that `card` replaces as updated below it. */
async function markReplacedCards(cfg: OpenClawConfig, card: WhatsAppApprovalCard): Promise<void> {
  const text = buildWhatsAppPluginApprovalOutcomeText("superseded");
  for (const replaced of await consumeWhatsAppApprovalCardsReplacedBy(card)) {
    try {
      await editMessageWhatsApp(replaced.remoteJid, replaced.messageId, text, {
        cfg,
        accountId: replaced.accountId,
      });
    } catch (error) {
      // WhatsApp edits only recent messages; the old card keeps its cancellation text.
      log.warn(
        `whatsapp approvals: failed to mark prompt ${replaced.messageId} replaced: ${String(error)}`,
      );
    }
  }
}

/** One reminder below an expired card while its recipients' messages still wait. */
async function remindOfWaitingRecipients(
  cfg: OpenClawConfig,
  entry: WhatsAppApprovalMessage,
  card: WhatsAppApprovalCard,
): Promise<void> {
  const text = buildWhatsAppApprovalReminderText(
    await readRecipientMessages(card.recipients, card.accountId),
    cfg.agents?.defaults?.userTimezone,
    Date.now(),
  );
  if (!text) {
    return;
  }
  const result = await sendMessageWhatsApp(entry.to, text, {
    cfg,
    verbose: getWhatsAppRuntime().logging.shouldLogVerbose(),
    accountId: entry.accountId,
    quotedMessageKey: {
      id: entry.messageId,
      remoteJid: entry.remoteJid,
      fromMe: true,
      messageText: entry.text,
    },
  });
  await recordWhatsAppApprovalHistory(entry, text, result.messageId);
}

const closingOf = (outcome: WhatsAppPluginApprovalOutcome) =>
  outcome === "cancelled" || outcome === "expired" ? outcome : "decided";

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
    buildResolvedResult: ({ request, resolved, view }) => {
      const deliveryPending =
        resolved.decision === "allow-once" || resolved.decision === "allow-always";
      if (view.approvalKind !== "plugin") {
        return {
          kind: "update",
          payload: {
            deliveryPending,
            text: buildChannelApprovalResolvedText({ request, resolved, view }),
          },
        };
      }
      // A deny the approver's reaction did not make came from the run that asked stopping.
      const decidedByReaction = consumeWhatsAppApprovalReactionDecision(request.id);
      const outcome: WhatsAppPluginApprovalOutcome =
        resolved.decision === "deny" && !decidedByReaction ? "cancelled" : resolved.decision;
      return {
        kind: "update",
        payload: {
          deliveryPending,
          outcome,
          text: [
            buildWhatsAppPluginApprovalOutcomeText(outcome),
            deliveryPending ? view.description : undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      };
    },
    buildExpiredResult: ({ request, view }) => ({
      kind: "update",
      payload:
        view.approvalKind === "plugin"
          ? { outcome: "expired", text: buildWhatsAppPluginApprovalOutcomeText("expired") }
          : { text: buildChannelApprovalExpiredText({ request, view }) },
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
      const recipients = await resolveWhatsAppMessageRecipients(
        "scope" in request.request ? request.request.scope : undefined,
        preparedTarget.accountId,
      );
      const timeZone = cfg.agents?.defaults?.userTimezone;
      const unanswered = buildWhatsAppApprovalUnansweredMessagesText(
        await readRecipientMessages(recipients, preparedTarget.accountId),
        timeZone,
        Date.now(),
      );
      const text = [unanswered, pendingPayload.reactionPayload.text ?? ""]
        .filter(Boolean)
        .join("\n\n");
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
      const sourceRunId = "runId" in request.request ? request.request.runId?.trim() : undefined;
      const entry: WhatsAppApprovalMessage = {
        accountId: preparedTarget.accountId,
        to: preparedTarget.to,
        remoteJid: result.toJid,
        messageId: result.messageId,
        text,
        ...(sourceSessionKey ? { sourceSessionKey } : {}),
      };
      if (recipients) {
        entry.recipientSessionKeys = recipients.map((peerE164) =>
          resolveWhatsAppDirectSessionKey({ cfg, accountId: entry.accountId, peerE164 }),
        );
        entry.card = {
          accountId: entry.accountId,
          remoteJid: entry.remoteJid,
          messageId: entry.messageId,
          recipients,
          ...(sourceSessionKey ? { sourceSessionKey } : {}),
          ...(sourceRunId ? { sourceRunId } : {}),
          ...("description" in request.request && request.request.description
            ? { description: request.request.description }
            : {}),
        };
      }
      await recordWhatsAppApprovalHistory(entry, text, result.messageId);
      if ("title" in request.request) {
        await rememberWhatsAppApprovalDelivery(request.request, entry);
      }
      if (entry.card) {
        await markReplacedCards(cfg, entry.card);
        await recordWhatsAppApprovalCardDelivered(entry.card);
      }
      return entry;
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      if (!payload.deliveryPending) {
        await forgetWhatsAppApprovalDelivery(entry);
      }
      if (entry.card && payload.outcome) {
        await recordWhatsAppApprovalCardClosed(entry.card, closingOf(payload.outcome), Date.now());
      }
      if (entry.card && (payload.outcome === "expired" || payload.outcome === "deny")) {
        recordWhatsAppApprovalCardDeclined(entry.card);
      }
      if (entry.card && payload.outcome === "expired") {
        await remindOfWaitingRecipients(cfg, entry, entry.card);
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
