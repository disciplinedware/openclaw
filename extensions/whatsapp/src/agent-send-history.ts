import { formatMediaPlaceholderText } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getActiveWebListener } from "./active-listener.js";
import { isWhatsAppOwnerTarget, normalizeWhatsAppTarget } from "./normalize-target.js";
import { recordWhatsAppAssistantMessageHistory } from "./own-message-history.js";
import { findWhatsAppOwnerE164 } from "./owner-target.js";
import { getWhatsAppRuntime } from "./runtime.js";
import {
  listWhatsAppOwnerSessionAccounts,
  resolveWhatsAppDirectSessionKey,
} from "./session-route.js";

/** The parts of OpenClaw's `after_tool_call` event that this module reads. */
export type WhatsAppAgentSendToolCall = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: string;
};

/** The parts of OpenClaw's tool hook context that this module reads. */
type WhatsAppAgentSendToolContext = {
  sessionKey?: string;
};

/** A `message` send that reached one person's WhatsApp chat. */
type DeliveredWhatsAppDirectSend = {
  /** The `accountId` argument of the call; absent, core sends through the run's account. */
  explicitAccountId?: string;
  peerE164: string;
  messageId: string;
  text: string;
};

/**
 * Reads a successful `message` tool send to a WhatsApp direct chat. The tool result's details are
 * the core send result: `channel`, the resolved `to`, the media sent and the platform `result`.
 */
export function readDeliveredWhatsAppDirectSend(
  call: WhatsAppAgentSendToolCall,
  cfg: OpenClawConfig,
): DeliveredWhatsAppDirectSend | undefined {
  if (
    call.toolName !== "message" ||
    call.error ||
    normalizeOptionalString(call.params.action) !== "send"
  ) {
    return undefined;
  }
  const details = asOptionalRecord(asOptionalRecord(call.result)?.details);
  if (normalizeOptionalString(details?.channel) !== "whatsapp" || details?.dryRun === true) {
    return undefined;
  }
  const deliveryStatus = normalizeOptionalString(details?.deliveryStatus);
  if (deliveryStatus && deliveryStatus !== "sent") {
    return undefined;
  }
  const to = normalizeOptionalString(details?.to);
  if (!to) {
    return undefined;
  }
  const peer = isWhatsAppOwnerTarget(to) ? findWhatsAppOwnerE164(cfg) : normalizeWhatsAppTarget(to);
  if (!peer?.startsWith("+")) {
    return undefined;
  }
  const mediaUrls = Array.isArray(details?.mediaUrls)
    ? details.mediaUrls.filter((url): url is string => typeof url === "string")
    : [];
  const text = [
    normalizeOptionalString(call.params.message),
    formatMediaPlaceholderText(mediaUrls.map((url) => ({ url }))),
  ]
    .filter(Boolean)
    .join("\n");
  const messageId = normalizeOptionalString(asOptionalRecord(details?.result)?.messageId);
  if (!text || !messageId) {
    return undefined;
  }
  const explicitAccountId = normalizeOptionalString(call.params.accountId);
  return {
    ...(explicitAccountId ? { explicitAccountId } : {}),
    peerE164: peer,
    messageId,
    text,
  };
}

/**
 * Records an agent's `message` send made in the owner's direct chat into the recipient's chat
 * history, so the recipient's next turn knows what the owner's chat wrote to them. Only the owner's
 * chat writes this way: a send from anyone else's chat can carry that person's words, and recorded
 * as the assistant's own message in another chat they would be read as the assistant's, with that
 * chat's tools. A send from the recipient's own session is already in its transcript.
 */
async function recordWhatsAppAgentSendHistory(params: {
  call: WhatsAppAgentSendToolCall;
  context: WhatsAppAgentSendToolContext;
  cfg: OpenClawConfig;
  nowMs: number;
}): Promise<void> {
  const send = readDeliveredWhatsAppDirectSend(params.call, params.cfg);
  if (!send) {
    return;
  }
  const owner = findWhatsAppOwnerE164(params.cfg);
  const sendingSession = params.context.sessionKey?.trim().toLowerCase();
  if (!owner || !sendingSession || send.peerE164 === owner) {
    return;
  }
  // Without an explicit `accountId`, core sends through the run's account, which must be the only
  // account on which the sending session is the owner's direct chat.
  const ownerSessionAccounts = listWhatsAppOwnerSessionAccounts({
    cfg: params.cfg,
    sessionKey: sendingSession,
    ownerE164: owner,
  });
  const accountId =
    ownerSessionAccounts.length === 0
      ? undefined
      : (send.explicitAccountId ??
        (ownerSessionAccounts.length === 1 ? ownerSessionAccounts[0] : undefined));
  if (!accountId) {
    return;
  }
  // The recipient's chat is keyed by the number as WhatsApp registers it, which the send resolved.
  const recipients = getActiveWebListener(accountId)?.recipients;
  if (!recipients) {
    throw new Error(`no live WhatsApp connection for account ${accountId}`);
  }
  const peerE164 = await recipients.resolveE164(send.peerE164);
  if (
    peerE164 === owner ||
    resolveWhatsAppDirectSessionKey({ cfg: params.cfg, accountId, peerE164 }) === sendingSession
  ) {
    return;
  }
  await recordWhatsAppAssistantMessageHistory({
    accountId,
    peerE164,
    messageId: send.messageId,
    text: send.text,
    timestampMs: params.nowMs,
  });
}

export function registerWhatsAppAgentSendHistory(api: OpenClawPluginApi): void {
  api.on("after_tool_call", async (event, ctx) => {
    if (event.toolName !== "message") {
      return;
    }
    try {
      await recordWhatsAppAgentSendHistory({
        call: event,
        context: ctx,
        cfg: getRuntimeConfig(),
        nowMs: Date.now(),
      });
    } catch (error) {
      getWhatsAppRuntime()
        .logging.getChildLogger({ feature: "agent-send-history" })
        .warn("WhatsApp: failed to record an agent send into the recipient's history", {
          error: String(error),
        });
    }
  });
}
