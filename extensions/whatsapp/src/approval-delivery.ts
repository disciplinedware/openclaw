import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
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
  buildWhatsAppPluginApprovalOutcomeText,
  type WhatsAppApprovalDeliveryOutcome,
} from "./approval-text.js";
import { createKeyedWriteQueue, createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getWhatsAppRuntime } from "./runtime.js";
import { editMessageWhatsApp, sendMessageWhatsApp } from "./send.js";

const processIdentity = `${process.pid}:${performance.timeOrigin}`;
type StoredApprovalDelivery = {
  processIdentity: string;
  entry: WhatsAppApprovalMessage;
  outcome?: WhatsAppApprovalDeliveryOutcome;
  cardKey?: string;
  /** Set when the approver approved the card. */
  approved?: true;
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

type ReceiptLogger = { error: (message: string) => void };

async function deliverReceipt(
  key: string,
  stored: StoredApprovalDelivery,
  log: ReceiptLogger,
): Promise<void> {
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
    log.error(
      `WhatsApp approval delivery receipt retained for recovery, card ${entry.messageId}: ${String(error)}`,
    );
  }
}

async function queueReceipt(
  cardKey: string,
  stored: StoredApprovalDelivery,
  outcome: WhatsAppApprovalDeliveryOutcome,
  log: ReceiptLogger,
): Promise<void> {
  const key = JSON.stringify(["receipt", cardKey]);
  const receipt = { ...stored, processIdentity, outcome, cardKey };
  if (await openStore(getWhatsAppRuntime()).registerIfAbsent(key, receipt)) {
    await deliverReceipt(key, receipt, log);
  }
}

/** Records the approver's approval of a card, so a process that stops before the send settles reports it as unknown. */
export async function recordWhatsAppApprovalDeliveryApproved(
  entry: WhatsAppApprovalMessage,
): Promise<void> {
  if (!entry.deliveryKey) {
    return;
  }
  const store = openStore(getWhatsAppRuntime());
  const stored = await store.lookup(entry.deliveryKey);
  if (stored && !stored.approved) {
    await store.register(entry.deliveryKey, { ...stored, approved: true });
  }
}

const recoveryWrites = createKeyedWriteQueue(
  "openclaw.whatsapp-for-business.approvalDeliveryRecovery",
);

/**
 * Settles the cards an earlier process left on an account, once its WhatsApp connection is live,
 * because a receipt sent before that fails and waits for the next start. An approved card whose
 * send never settled gets the receipt that delivery is unknown. A card the approver never decided
 * sent nothing: the run that asked ended with that process, so the card reads cancelled.
 */
export async function drainWhatsAppApprovalDeliveries(
  accountId: string,
  log: ReceiptLogger,
): Promise<void> {
  const store = openStore(getWhatsAppRuntime());
  for (const { key, value } of await store.entries()) {
    if (value.processIdentity === processIdentity || value.entry.accountId !== accountId) {
      continue;
    }
    await recoveryWrites(key, async () => {
      const stored = await store.lookup(key);
      if (!stored) {
        return;
      }
      if (stored.outcome) {
        await deliverReceipt(key, stored, log);
      } else if (stored.approved) {
        await queueReceipt(key, stored, "unknown", log);
      } else {
        await closeUndecidedCard(key, stored, log);
      }
    });
  }
}

async function closeUndecidedCard(
  key: string,
  stored: StoredApprovalDelivery,
  log: ReceiptLogger,
): Promise<void> {
  const { entry } = stored;
  const text = buildWhatsAppPluginApprovalOutcomeText("cancelled");
  try {
    await editMessageWhatsApp(entry.remoteJid, entry.messageId, text, {
      cfg: getRuntimeConfig(),
      accountId: entry.accountId,
    });
    await recordWhatsAppApprovalHistory(entry, text, `${entry.messageId}:outcome`);
  } catch (error) {
    // WhatsApp edits only recent messages; an old card keeps its text, and nothing was sent.
    log.error(`WhatsApp approval card ${entry.messageId} not marked cancelled: ${String(error)}`);
  }
  await openStore(getWhatsAppRuntime()).delete(key);
}

export function registerWhatsAppApprovalDelivery(api: OpenClawPluginApi): void {
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
    await queueReceipt(key, stored, deliveryOutcome(event), api.logger);
  });
}
