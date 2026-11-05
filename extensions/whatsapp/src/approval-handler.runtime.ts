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
import {
  forgetOpenWhatsAppMessageCard,
  takeWhatsAppMessageCardAnswered,
  trackOpenWhatsAppMessageCard,
} from "./approval-answered.js";
import {
  buildWhatsAppMessageCard,
  buildWhatsAppMessageCardOutcomeText,
  isWhatsAppMessageApproval,
} from "./approval-card.js";
import {
  registerWhatsAppApprovalReactionTarget,
  unregisterWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import { normalizeWhatsAppMessagingTarget } from "./normalize-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { editMessageWhatsApp, sendMessageWhatsApp, sendTypingWhatsApp } from "./send.js";

const log = createSubsystemLogger("whatsapp/approvals");

type PreparedWhatsAppApprovalTarget = {
  to: string;
  accountId: string;
};
type PendingWhatsAppApprovalEntry = {
  accountId: string;
  to: string;
  remoteJid: string;
  /** The card's WhatsApp messages, in order: a long card arrives in parts, and each answers. */
  messageIds: string[];
  /** The text of the card's last part and the footer it ends with; the outcome replaces the footer. */
  lastPartText: string;
  footer?: string;
  approvalId?: string;
};
type WhatsAppPendingPayload = ApprovalReactionPendingContent & { footer?: string };

const listCardParts = (entry: PendingWhatsAppApprovalEntry) =>
  entry.messageIds.map((messageId) => ({
    accountId: entry.accountId,
    remoteJid: entry.remoteJid,
    messageId,
  }));
type WhatsAppFinalPayload = {
  text: string;
  /** A message card's outcome line, which replaces the card's footer in place. */
  cardOutcome?: string;
};

export const whatsappApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  WhatsAppPendingPayload,
  PreparedWhatsAppApprovalTarget,
  PendingWhatsAppApprovalEntry,
  true,
  WhatsAppFinalPayload
>({
  eventKinds: ["exec", "plugin", "system-agent"],
  availability: {
    isConfigured: ({ context }) => Boolean(context),
    shouldHandle: ({ context }) => Boolean(context),
  },
  presentation: {
    buildPendingPayload: async (params) => {
      const content = buildApprovalReactionPendingContent(params);
      if (params.approvalKind !== "plugin" || !isWhatsAppMessageApproval(params.request)) {
        return content;
      }
      const card = await buildWhatsAppMessageCard({
        cfg: params.cfg,
        request: params.request,
        allowedDecisions: content.reactionPayload.allowedDecisions,
        nowMs: params.nowMs,
      });
      if (card) {
        return {
          ...content,
          reactionPayload: { ...content.reactionPayload, text: card.text },
          footer: card.footer,
        };
      }
      // Nobody approves a message the card cannot show: OpenClaw's own text, with 👎 only.
      log.warn(`whatsapp approvals: ${params.request.id} shows no proposed message; only 👎`);
      const request = params.request.request;
      return buildApprovalReactionPendingContent({
        ...params,
        request: { ...params.request, request: { ...request, allowedDecisions: ["deny"] } },
        view: {
          ...params.view,
          actions: params.view.actions.filter((action) => action.decision === "deny"),
        },
      });
    },
    buildResolvedResult: ({ cfg, request, resolved, view }) => {
      if (view.approvalKind !== "plugin" || !isWhatsAppMessageApproval(request)) {
        return {
          kind: "update",
          payload: { text: buildChannelApprovalResolvedText({ request, resolved, view }) },
        };
      }
      const answered = takeWhatsAppMessageCardAnswered(request.id);
      const text = buildWhatsAppMessageCardOutcomeText(
        cfg,
        answered && resolved.decision === "deny" ? "answered" : resolved.decision,
      );
      return { kind: "update", payload: { text, cardOutcome: text } };
    },
    buildExpiredResult: ({ cfg, request, view }) => {
      if (view.approvalKind !== "plugin" || !isWhatsAppMessageApproval(request)) {
        return {
          kind: "update",
          payload: { text: buildChannelApprovalExpiredText({ request, view }) },
        };
      }
      takeWhatsAppMessageCardAnswered(request.id);
      const text = buildWhatsAppMessageCardOutcomeText(cfg, "expired");
      return { kind: "update", payload: { text, cardOutcome: text } };
    },
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
    deliverPending: async ({ cfg, preparedTarget, pendingPayload }) => {
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      await sendTypingWhatsApp(preparedTarget.to, {
        cfg,
        accountId: preparedTarget.accountId,
      }).catch(() => {});
      const cardText = pendingPayload.reactionPayload.text ?? "";
      const parts: Array<{ messageId: string; text: string }> = [];
      const result = await sendMessageWhatsApp(preparedTarget.to, cardText, {
        cfg,
        verbose,
        accountId: preparedTarget.accountId,
        preserveLeadingWhitespace: true,
        // Reported only for a card sent in several parts, once per part.
        onDeliveryResult: ({ messageId, text }) => {
          parts.push({ messageId, text });
        },
      });
      if (!result.messageId) {
        return null;
      }
      return {
        accountId: preparedTarget.accountId,
        to: preparedTarget.to,
        remoteJid: result.toJid,
        messageIds: parts.length > 0 ? parts.map((part) => part.messageId) : [result.messageId],
        lastPartText: parts.at(-1)?.text ?? cardText,
        ...(pendingPayload.footer ? { footer: pendingPayload.footer } : {}),
      };
    },
    updateEntry: async ({ cfg, entry, payload }) => {
      if (entry.approvalId) {
        forgetOpenWhatsAppMessageCard(entry.approvalId);
      }
      const lastPartId = entry.messageIds.at(-1);
      if (
        payload.cardOutcome &&
        entry.footer &&
        lastPartId &&
        entry.lastPartText.endsWith(entry.footer)
      ) {
        // The card itself shows how it ended: its footer with the reactions becomes the outcome.
        const closed = `${entry.lastPartText.slice(0, -entry.footer.length)}${payload.cardOutcome}`;
        try {
          await editMessageWhatsApp(entry.remoteJid, lastPartId, closed, {
            cfg,
            accountId: entry.accountId,
          });
          return;
        } catch (error) {
          log.warn(
            `whatsapp approvals: card ${lastPartId} keeps its reactions; the outcome follows as a reply: ${String(error)}`,
          );
        }
      }
      const verbose = getWhatsAppRuntime().logging.shouldLogVerbose();
      await sendMessageWhatsApp(entry.to, payload.text, {
        cfg,
        verbose,
        accountId: entry.accountId,
        preserveLeadingWhitespace: true,
        quotedMessageKey: {
          id: entry.messageIds.at(-1) ?? "",
          remoteJid: entry.remoteJid,
          fromMe: true,
        },
      });
    },
  },
  interactions: {
    bindPending: async ({ entry, request, view, pendingPayload }) => {
      if (view.approvalKind === "plugin" && isWhatsAppMessageApproval(request)) {
        entry.approvalId = request.id;
        trackOpenWhatsAppMessageCard({ request });
      }
      const bound = await Promise.all(
        listCardParts(entry).map((part) =>
          registerWhatsAppApprovalReactionTarget({
            ...part,
            approvalId: request.id,
            approvalKind: view.approvalKind,
            allowedDecisions: pendingPayload.reactionPayload.allowedDecisions,
            ttlMs: Math.max(1, view.expiresAtMs - Date.now()),
          }),
        ),
      );
      return bound.every(Boolean) ? true : null;
    },
    unbindPending: async ({ entry }) => {
      await Promise.all(listCardParts(entry).map(unregisterWhatsAppApprovalReactionTarget));
    },
    cancelDelivered: async ({ entry }) => {
      if (entry.approvalId) {
        forgetOpenWhatsAppMessageCard(entry.approvalId);
      }
      await Promise.all(listCardParts(entry).map(unregisterWhatsAppApprovalReactionTarget));
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      log.error(`whatsapp approvals: failed to send request ${request.id}: ${String(error)}`);
    },
  },
});
