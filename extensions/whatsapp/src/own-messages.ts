import type { proto, WAMessage } from "baileys";
import {
  formatInboundEnvelope,
  formatMediaPlaceholderText,
  type EnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import type { WhatsAppAccountConfig } from "./account-types.js";
import type { ResolvedWhatsAppAccount } from "./accounts.js";
import { isRecentOutboundMessage } from "./inbound/dedupe.js";
import { extractMediaKind, extractText, hasInboundUserContent } from "./inbound/extract.js";
import { isWhatsAppSentMessage } from "./inbound/sent-message-store.js";
import { isDirectUserJid } from "./inbound/socket-session.js";

/**
 * History sender label of an own message: the attribution OpenClaw's
 * `formatInboundEnvelope` gives a direct message with `fromMe`, so an entry
 * reads `(self): <text>` as the core writes such a message.
 */
export const WHATSAPP_OWN_MESSAGE_SENDER_LABEL = "(self)";

/** A message the linked phone itself sent, live, to another person's direct chat. */
export type WhatsAppOwnMessage = {
  accountId: string;
  messageId: string;
  /** Baileys remoteJid of the chat the message went to. */
  chatJid: string;
  /** The other person in that chat. */
  peerE164: string;
  timestampMs: number;
  text: string;
  mediaKind?: ReturnType<typeof extractMediaKind>;
};

/** Facts an own-message turn carries to the run (`channelContext.chat.ownMessage`). */
export type WhatsAppOwnMessageTurnFacts = Pick<
  WhatsAppOwnMessage,
  "messageId" | "peerE164" | "timestampMs"
>;

export function resolveWhatsAppOwnMessagesMode(
  account: Pick<ResolvedWhatsAppAccount, "ownMessages">,
): NonNullable<WhatsAppAccountConfig["ownMessages"]> {
  return account.ownMessages ?? "off";
}

// Sections that change, retract or react to a message instead of authoring one.
const NON_AUTHORED_SECTIONS = [
  "reactionMessage",
  "encReactionMessage",
  "protocolMessage",
  "editedMessage",
  "pollUpdateMessage",
  "keepInChatMessage",
  "pinInChatMessage",
] as const satisfies ReadonlyArray<keyof proto.IMessage>;

function isAuthoredMessage(message: proto.IMessage | null | undefined): boolean {
  let layer = message ?? undefined;
  // Wrappers nest a few levels at most; edits and revokes hide inside them.
  for (let depth = 0; layer && depth < 6; depth += 1) {
    const current: proto.IMessage = layer;
    if (NON_AUTHORED_SECTIONS.some((section) => current[section])) {
      return false;
    }
    layer =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      undefined;
  }
  return hasInboundUserContent(message ?? undefined);
}

/**
 * The cheap, synchronous part of own-message detection. Only live upserts qualify: Baileys
 * reports offline backfill and this socket's own sends as `append`, and history sync never
 * reaches `messages.upsert`.
 */
function readWhatsAppOwnMessageCandidate(
  msg: WAMessage,
  upsertType: string | undefined,
): { chatJid: string; alternateChatJid?: string; messageId: string } | null {
  if (upsertType !== "notify" || msg.key?.fromMe !== true) {
    return null;
  }
  const chatJid = msg.key.remoteJid?.trim();
  const messageId = msg.key.id?.trim();
  if (!chatJid || !messageId || !isDirectUserJid(chatJid) || !isAuthoredMessage(msg.message)) {
    return null;
  }
  const alternateChatJid = msg.key.remoteJidAlt?.trim();
  return { chatJid, messageId, ...(alternateChatJid ? { alternateChatJid } : {}) };
}

/** Returns the own message, or null for anything else, including echoes of this plugin's sends. */
export async function classifyWhatsAppOwnMessage(params: {
  msg: WAMessage;
  upsertType: string | undefined;
  accountId: string;
  selfE164: string | null | undefined;
  timestampMs: number;
  resolveInboundJid: (jid: string) => Promise<string | null>;
  logVerbose: (message: string) => void;
}): Promise<WhatsAppOwnMessage | null> {
  const candidate = readWhatsAppOwnMessageCandidate(params.msg, params.upsertType);
  if (!candidate) {
    return null;
  }
  const sentMessage = {
    accountId: params.accountId,
    remoteJid: candidate.chatJid,
    alternateRemoteJid: candidate.alternateChatJid,
    messageId: candidate.messageId,
  };
  if (isRecentOutboundMessage(sentMessage)) {
    return null;
  }
  try {
    if (await isWhatsAppSentMessage(sentMessage)) {
      return null;
    }
  } catch (error) {
    // Unknown provenance must not become an agent turn.
    params.logVerbose(
      `Skipping WhatsApp own message ${candidate.messageId}: sent-message state failed: ${String(error)}`,
    );
    return null;
  }
  const peerE164 =
    (await params.resolveInboundJid(candidate.chatJid)) ??
    (candidate.alternateChatJid
      ? await params.resolveInboundJid(candidate.alternateChatJid)
      : null);
  if (!peerE164) {
    params.logVerbose(
      `Skipping WhatsApp own message ${candidate.messageId}: no phone number for ${candidate.chatJid}`,
    );
    return null;
  }
  if (params.selfE164 && peerE164 === params.selfE164) {
    return null;
  }
  return {
    accountId: params.accountId,
    messageId: candidate.messageId,
    chatJid: candidate.chatJid,
    peerE164,
    timestampMs: params.timestampMs,
    text: extractText(params.msg.message ?? undefined)?.trim() ?? "",
    mediaKind: extractMediaKind(params.msg.message ?? undefined),
  };
}

/** The message as text: its text, then a placeholder for its media. */
export function formatWhatsAppOwnMessageContent(
  message: Pick<WhatsAppOwnMessage, "text" | "mediaKind">,
): string {
  const media = message.mediaKind ? formatMediaPlaceholderText([{ kind: message.mediaKind }]) : "";
  return [message.text, media].filter(Boolean).join("\n");
}

/**
 * Body of the owner turn: the own message as OpenClaw writes a message the
 * account itself sent in a direct chat (`formatInboundEnvelope`, `fromMe`):
 * `[WhatsApp <other person> <time>] (self): <text>`.
 */
export function formatWhatsAppOwnMessageTurnBody(
  message: Pick<WhatsAppOwnMessage, "peerE164" | "timestampMs" | "text" | "mediaKind">,
  envelope: EnvelopeFormatOptions,
): string {
  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: message.peerE164,
    timestamp: message.timestampMs,
    body: formatWhatsAppOwnMessageContent(message),
    chatType: "direct",
    envelope,
    fromMe: true,
  });
}
