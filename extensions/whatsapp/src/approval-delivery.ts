import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readDeliveredWhatsAppDirectSend,
  type WhatsAppAgentSendToolCall,
} from "./agent-send-history.js";
import { recordWhatsAppApprovalHistory, type WhatsAppApprovalMessage } from "./approval-history.js";
import {
  buildWhatsAppApprovalDeliveryText,
  type WhatsAppApprovalDeliveryOutcome,
} from "./approval-text.js";
import { createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { sendMessageWhatsApp } from "./send.js";

const processIdentity = `${process.pid}:${performance.timeOrigin}`;
type StoredApprovalDelivery = {
  processIdentity: string;
  entry: WhatsAppApprovalMessage;
  outcome?: WhatsAppApprovalDeliveryOutcome;
  cardKey?: string;
};
const openStore = createPerRuntimeStoreOpener((runtime) =>
  runtime.state.openKeyedStore<StoredApprovalDelivery>({
    namespace: "whatsapp.approval-delivery",
    retention: "retained",
  }),
);

function deliveryKey(runId: string, toolCallId: string, sessionKey: string): string {
  return JSON.stringify([processIdentity, runId, toolCallId, sessionKey]);
}

/** What the model reads for a send whose run stopped before anyone approved its card. */
export const WHATSAPP_UNAPPROVED_SEND_RESULT_TEXT =
  "Not sent: the run stopped while this message waited for approval, so the recipient has not seen it.";

type SendAwaitingApproval = { cardKey: string; allowSubmitted: boolean };

// Keyed by session and tool call, the identities of a transcript tool result. Process-global
// because the plugin loads in several module instances; a restart forgets it, and the core's
// "outcome unknown" result then stands.
const sendsAwaitingApproval = resolveGlobalMap<string, SendAwaitingApproval>(
  Symbol.for("openclaw.whatsapp-for-business.sendsAwaitingApproval"),
);

const toolKey = (sessionKey: string, toolCallId: string) =>
  JSON.stringify([sessionKey, toolCallId]);
const cardKeyOf = (card: { accountId: string; messageId: string }) =>
  JSON.stringify([card.accountId, card.messageId]);

/**
 * Records that someone may have allowed the send behind a card. The core runs an allowed send
 * before it tells this channel the decision, so a WhatsApp reaction records its allow before it
 * submits it. An allow from another approval route reaches this channel only with the decision.
 */
export function noteWhatsAppApprovalAllowSubmitted(card: {
  accountId: string;
  messageId: string;
}): void {
  const cardKey = cardKeyOf(card);
  for (const send of sendsAwaitingApproval.values()) {
    if (send.cardKey === cardKey) {
      send.allowSubmitted = true;
    }
  }
}

export async function rememberWhatsAppApprovalDelivery(
  request: {
    toolName?: string | null;
    runId?: string | null;
    toolCallId?: string | null;
    sessionKey?: string | null;
    scope?: { kind: string; target?: string } | null;
  },
  entry: WhatsAppApprovalMessage,
): Promise<void> {
  if (
    request.toolName !== "message" ||
    request.scope?.kind !== "message-send" ||
    request.scope.target !== "whatsapp"
  ) {
    return;
  }
  if (!request.runId || !request.toolCallId || !request.sessionKey) {
    throw new Error(
      "WhatsApp approval delivery needs native run, session and tool-call identities",
    );
  }
  const key = deliveryKey(request.runId, request.toolCallId, request.sessionKey);
  await openStore(getWhatsAppRuntime()).register(key, { processIdentity, entry });
  entry.deliveryKey = key;
  sendsAwaitingApproval.set(toolKey(request.sessionKey, request.toolCallId), {
    cardKey: cardKeyOf(entry),
    allowSubmitted: false,
  });
}

export async function forgetWhatsAppApprovalDelivery(
  entry: WhatsAppApprovalMessage,
): Promise<void> {
  if (entry.deliveryKey) {
    await openStore(getWhatsAppRuntime()).delete(entry.deliveryKey);
  }
}

function deliveryOutcome(call: WhatsAppAgentSendToolCall): WhatsAppApprovalDeliveryOutcome {
  const details = asOptionalRecord(asOptionalRecord(call.result)?.details);
  const status = normalizeOptionalString(details?.deliveryStatus);
  if (status === "failed" || status === "suppressed" || status === "dry_run") {
    return "failed";
  }
  if (call.error || status === "partial_failed" || details?.dryRun === true) {
    return "unknown";
  }
  if (readDeliveredWhatsAppDirectSend(call, getRuntimeConfig())) {
    return "sent";
  }
  if (call.params.action === "react" && details?.ok === true && typeof details.added === "string") {
    return "sent";
  }
  return "unknown";
}

export function registerWhatsAppApprovalDelivery(api: OpenClawPluginApi): void {
  const deliverReceipt = async (key: string, stored: StoredApprovalDelivery): Promise<void> => {
    const { entry, outcome, cardKey } = stored;
    if (!outcome || !cardKey) {
      throw new Error("WhatsApp delivery receipt lacks its settled outcome or approval card");
    }
    const text = buildWhatsAppApprovalDeliveryText(outcome);
    try {
      const result = await sendMessageWhatsApp(entry.to, text, {
        cfg: getRuntimeConfig(),
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
      const store = openStore(getWhatsAppRuntime());
      await store.delete(cardKey);
      await store.delete(key);
    } catch (error) {
      api.logger.error(
        `WhatsApp approval delivery receipt retained for recovery, card ${entry.messageId}: ${String(error)}`,
      );
    }
  };
  const queueReceipt = async (
    cardKey: string,
    stored: StoredApprovalDelivery,
    outcome: WhatsAppApprovalDeliveryOutcome,
  ) => {
    const key = JSON.stringify(["receipt", cardKey]);
    const receipt = { ...stored, processIdentity, outcome, cardKey };
    if (await openStore(getWhatsAppRuntime()).registerIfAbsent(key, receipt)) {
      await deliverReceipt(key, receipt);
    }
  };
  api.on("gateway_start", async () => {
    const store = openStore(getWhatsAppRuntime());
    for (const { key, value } of await store.entries()) {
      if (!(await store.lookup(key))) {
        continue;
      }
      if (value.processIdentity !== processIdentity) {
        if (value.outcome) {
          await deliverReceipt(key, value);
        } else {
          await queueReceipt(key, value, "unknown");
        }
      }
    }
  });
  // A new message that interrupts the run while the card waits leaves the send without a result,
  // and the core records "outcome unknown". The send never ran, so the model reads that it was not
  // sent and answers its questions again.
  api.on("tool_result_persist", (event, ctx) => {
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    if (!toolCallId || !ctx.sessionKey) {
      return;
    }
    const key = toolKey(ctx.sessionKey, toolCallId);
    const send = sendsAwaitingApproval.get(key);
    if (!send) {
      return;
    }
    sendsAwaitingApproval.delete(key);
    if (!event.isSynthetic || send.allowSubmitted || event.message.role !== "toolResult") {
      return;
    }
    return {
      message: {
        ...event.message,
        content: [{ type: "text", text: WHATSAPP_UNAPPROVED_SEND_RESULT_TEXT }],
      },
    };
  });
  api.on("after_tool_call", async (event, ctx) => {
    const runId = event.runId ?? ctx.runId;
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    if (event.toolName !== "message" || !runId || !toolCallId || !ctx.sessionKey) {
      return;
    }
    const key = deliveryKey(runId, toolCallId, ctx.sessionKey);
    const stored = await openStore(getWhatsAppRuntime()).lookup(key);
    if (!stored) {
      return;
    }
    await queueReceipt(key, stored, deliveryOutcome(event));
  });
}
