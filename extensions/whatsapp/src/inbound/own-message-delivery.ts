import type { WAMessage } from "baileys";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listWhatsAppCommandOwners } from "../command-owner.js";
import { resolveComparableIdentity, type WhatsAppSelfIdentity } from "../identity.js";
import { recordWhatsAppOwnMessageHistory } from "../own-message-history.js";
import {
  classifyWhatsAppOwnMessage,
  formatWhatsAppOwnMessageTurnBody,
  resolveWhatsAppOwnMessagesMode,
  type WhatsAppOwnMessage,
} from "../own-messages.js";
import { toWhatsappJid } from "../targets-runtime.js";
import { checkInboundAccessControl } from "./access-control.js";
import type { WhatsAppIngressAdmission, WhatsAppIngressLifecycle } from "./durable-receive.js";
import type { WhatsAppQueuedInboundMessage } from "./message-debounce.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";
import type { WebInboundCallbackMessage } from "./types.js";

type ChatTransport = Pick<
  WebInboundCallbackMessage["platform"],
  "sendComposing" | "reply" | "sendMedia"
>;

/**
 * Handles messages the linked phone itself sends (`ownMessages`). The returned handler
 * answers undefined for every other message, which then takes the upstream path.
 */
export function createWhatsAppOwnMessageHandler(deps: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  accountId: string;
  verbose: boolean;
  self: WhatsAppSelfIdentity;
  resolveInboundJid: WhatsAppAttachedSocketSession["resolveInboundJid"];
  sendTrackedMessage: WhatsAppAttachedSocketSession["sendTrackedMessage"];
  createChatTransport: (chatJid: string) => ChatTransport;
  enqueue: (message: WhatsAppQueuedInboundMessage) => Promise<void>;
  parseTimestampSeconds: (value: unknown) => number | undefined;
  logVerbose: (message: string) => void;
  logWarn: (message: string, details: Record<string, unknown>) => void;
}) {
  const currentConfig = () => deps.loadConfig?.() ?? deps.cfg;

  // Runs the turn in the owner's direct chat, as if the owner had written to this account.
  // The owner is the first WhatsApp command owner, as for OpenClaw's owner route; the owner
  // goes through normal DM admission, and a refused or missing owner gets no turn.
  const enqueueOwnerTurn = async (
    ownMessage: WhatsAppOwnMessage,
    durable: { receiveOrder?: number; turnAdoptionLifecycle: WhatsAppIngressLifecycle },
  ): Promise<boolean> => {
    const owner = listWhatsAppCommandOwners(currentConfig())[0];
    if (!owner) {
      deps.logWarn("whatsapp own message: commands.ownerAllowFrom names no WhatsApp owner", {
        messageId: ownMessage.messageId,
      });
      return false;
    }
    const ownerJid = toWhatsappJid(owner);
    const access = await checkInboundAccessControl({
      cfg: currentConfig(),
      accountId: deps.accountId,
      from: owner,
      selfE164: deps.self.e164 ?? null,
      senderE164: owner,
      group: false,
      isFromMe: false,
      suppressPairingChallenge: true,
      verbose: deps.verbose,
      sock: { sendMessage: (jid, content) => deps.sendTrackedMessage(jid, content) },
      remoteJid: ownerJid,
    });
    if (!access.allowed) {
      deps.logWarn("whatsapp own message: the owner is not admitted by dmPolicy/allowFrom", {
        messageId: ownMessage.messageId,
      });
      return false;
    }
    const body = formatWhatsAppOwnMessageTurnBody(
      ownMessage,
      resolveEnvelopeFormatOptions(currentConfig()),
    );
    await deps.enqueue({
      admission: access.admission,
      // No event id: the owner chat holds no such message to react to, mark read or quote.
      event: { timestamp: ownMessage.timestampMs },
      payload: { body, commandBody: body },
      platform: {
        chatJid: ownerJid,
        recipientJid: deps.self.e164 ?? "me",
        sender: resolveComparableIdentity({ e164: owner }),
        senderE164: owner,
        self: deps.self,
        selfJid: deps.self.jid ?? undefined,
        selfLid: deps.self.lid ?? undefined,
        selfE164: deps.self.e164 ?? undefined,
        fromMe: false,
        ...deps.createChatTransport(ownerJid),
      },
      ownMessage: {
        messageId: ownMessage.messageId,
        peerE164: ownMessage.peerE164,
        timestampMs: ownMessage.timestampMs,
      },
      turnAdoptionLifecycle: durable.turnAdoptionLifecycle,
      receiveOrder: durable.receiveOrder,
    });
    return true;
  };

  return async (
    msg: WAMessage,
    context: Omit<WhatsAppIngressAdmission, "message">,
    lifecycle: WhatsAppIngressLifecycle,
  ): Promise<"completed" | "deferred" | undefined> => {
    if (msg.key?.fromMe !== true) {
      return undefined;
    }
    const mode = resolveWhatsAppOwnMessagesMode(currentConfig());
    if (mode === "off") {
      return undefined;
    }
    const timestampSeconds = deps.parseTimestampSeconds(msg.messageTimestamp);
    const ownMessage = await classifyWhatsAppOwnMessage({
      msg,
      upsertType: context.upsertType,
      accountId: deps.accountId,
      selfE164: deps.self.e164,
      timestampMs: timestampSeconds !== undefined ? timestampSeconds * 1000 : context.receivedAt,
      resolveInboundJid: deps.resolveInboundJid,
      logVerbose: deps.logVerbose,
    });
    if (!ownMessage) {
      return undefined;
    }
    // Replay after a crash re-registers the same key, so this step is idempotent.
    await recordWhatsAppOwnMessageHistory(ownMessage);
    if (mode !== "turn") {
      return "completed";
    }
    const enqueued = await enqueueOwnerTurn(ownMessage, {
      receiveOrder: context.receiveOrder ?? context.receivedAt,
      turnAdoptionLifecycle: lifecycle,
    });
    return enqueued ? "deferred" : "completed";
  };
}
