import {
  getPrimaryIdentityId,
  getReplyContext,
  getSenderIdentity,
  type WhatsAppReplyContext,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatInboundEnvelope, type EnvelopeFormatOptions } from "./message-line.runtime.js";

function formatReplyTarget(replyTo: WhatsAppReplyContext | null) {
  if (!replyTo?.body) {
    return null;
  }
  const sender = replyTo.sender?.label ?? replyTo.sender?.e164 ?? "unknown sender";
  const idPart = replyTo.id ? ` id:${replyTo.id}` : "";
  return `[Replying to ${sender}${idPart}]\n${replyTo.body}\n[/Replying]`;
}

/** The envelope `from` of a WhatsApp conversation: the group id, or the bare direct peer. */
export function formatWhatsAppEnvelopeFrom(conversation: {
  id: string;
  kind: "direct" | "group";
}): string {
  return conversation.kind === "group"
    ? conversation.id
    : conversation.id.replace(/^whatsapp:/, "");
}

export function buildInboundLine(params: {
  msg: AdmittedWebInboundMessage;
  previousTimestamp?: number;
  envelope?: EnvelopeFormatOptions;
  visibleReplyTo?: WhatsAppReplyContext | null;
}) {
  const { msg, previousTimestamp, envelope } = params;
  if (msg.ownMessage) {
    // The owner turn's body already is the envelope of the own message, from the other person's chat.
    return msg.payload.body;
  }
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationKind = admission.conversation.kind;
  const replyContext = formatReplyTarget(
    params.visibleReplyTo === undefined ? getReplyContext(msg) : params.visibleReplyTo,
  );
  const baseLine = `${msg.payload.body}${replyContext ? `\n\n${replyContext}` : ""}`;
  const sender = getSenderIdentity(msg);

  return formatInboundEnvelope({
    channel: "WhatsApp",
    from: formatWhatsAppEnvelopeFrom(admission.conversation),
    timestamp: msg.event.timestamp,
    body: baseLine,
    chatType: conversationKind,
    sender: {
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
      id: getPrimaryIdentityId(sender) ?? undefined,
    },
    previousTimestamp,
    envelope,
    fromMe: msg.platform.fromMe,
  });
}
