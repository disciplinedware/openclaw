import {
  formatAgentEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeWhatsAppMessageCardsAnsweredByBusiness } from "./approval-answered.js";
import { normalizeWhatsAppTarget } from "./normalize-target.js";
import { getWhatsAppRuntime } from "./runtime.js";

export async function recordWhatsAppConversationMessage(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  peer: string;
  messageId: string;
  text: string;
  timestampMs: number;
  author: "phone" | "guest" | "agent";
  sourceSessionKey?: string;
}): Promise<void> {
  const peer = normalizeWhatsAppTarget(params.peer);
  if (!peer?.startsWith("+")) {
    return;
  }
  const { cfg } = params;
  const route = resolveAgentRoute({
    cfg,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: { kind: "direct", id: peer },
  });
  if (params.author === "agent" && params.sourceSessionKey === route.sessionKey) {
    return;
  }
  const runtime = getWhatsAppRuntime();
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const entry = await runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: route.sessionKey,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "direct",
      AccountId: route.accountId,
      From: `whatsapp:${peer}`,
      OriginatingChannel: "whatsapp",
      OriginatingTo: `whatsapp:${peer}`,
    },
    createIfMissing: true,
  });
  if (!entry?.sessionId) {
    throw new Error(`WhatsApp conversation session was not registered for ${route.sessionKey}`);
  }
  const idempotencyKey = `whatsapp:${JSON.stringify([route.accountId, peer, params.messageId])}`;
  // See README.md: the pinned core supplies the transcript writer; no separate history store.
  const result = await appendSessionTranscriptMessageByIdentityStrict({
    agentId: route.agentId,
    config: cfg,
    eventId: idempotencyKey,
    idempotencyLookup: "scan",
    message: {
      role: "custom",
      customType: params.author === "guest" ? "whatsapp.inbound-history" : "whatsapp.history",
      display: true,
      content: [{ type: "text", text: params.text }],
      idempotencyKey,
    },
    preparation: {
      prepareMessage: (message) =>
        Promise.resolve({
          ...message,
          content: [
            {
              type: "text",
              text: formatAgentEnvelope({
                channel: "WhatsApp",
                from: peer,
                timestamp: params.timestampMs,
                body: `${params.author === "phone" ? "Business phone" : params.author === "agent" ? "Business agent" : "Guest"}: ${params.text}`,
                envelope: resolveEnvelopeFormatOptions(cfg),
              }),
            },
          ],
          timestamp: params.timestampMs,
        }),
    },
    now: params.timestampMs,
    sessionId: entry.sessionId,
    sessionKey: route.sessionKey,
    storePath,
    updateMode: "none",
  });
  if (result.kind !== "result") {
    throw new Error(
      `WhatsApp conversation transcript append ${result.kind} for ${route.sessionKey}`,
    );
  }
  if (params.author !== "guest") {
    // The business answered this guest; a card still proposing a reply here is stale.
    await closeWhatsAppMessageCardsAnsweredByBusiness({ cfg, sessionKey: route.sessionKey });
  }
}
