import {
  buildApprovalReactionHint,
  listApprovalReactionBindings,
  type ApprovalReactionDecisionBinding,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { WhatsAppUnansweredMessage } from "./overdue-answers.js";
import { readWhatsAppPluginConfig } from "./plugin-config.js";

type ApprovalDecision = ApprovalReactionDecisionBinding["decision"];
type ApprovalLanguage = "en" | "es";
export type WhatsAppApprovalDeliveryOutcome = "sent" | "failed" | "unknown";

const APPROVAL_DELIVERY_TEXT: Record<
  ApprovalLanguage,
  Record<WhatsAppApprovalDeliveryOutcome, string>
> = {
  en: {
    sent: "✅ Approved. 📤 Sent.",
    failed: "✅ Approved. ❌ Not sent.",
    unknown: "⚠️ Delivery could not be confirmed. Check the conversation before sending again.",
  },
  es: {
    sent: "✅ Aprobado. 📤 Enviado.",
    failed: "✅ Aprobado. ❌ No se envió.",
    unknown: "⚠️ No se pudo confirmar el envío. Revisa la conversación antes de volver a enviar.",
  },
};

export function buildWhatsAppApprovalDeliveryText(
  outcome: WhatsAppApprovalDeliveryOutcome,
): string {
  return APPROVAL_DELIVERY_TEXT[configuredApprovalLanguage()][outcome];
}

const SPANISH_REACTION_LABELS: Record<ApprovalDecision, string> = {
  "allow-once": "Aprobar una vez",
  "allow-always": "Aprobar siempre",
  deny: "Rechazar",
};

const MESSAGE_APPROVAL_TITLE = "Approve message?";

/**
 * How a plugin approval ended: a decision; `cancelled` when the run that asked stopped before any
 * decision (queue mode `interrupt`); `superseded` when a newer card for the same recipient followed
 * a cancelled one; `expired` when nobody answered in time.
 */
export type WhatsAppPluginApprovalOutcome =
  | ApprovalDecision
  | "cancelled"
  | "superseded"
  | "expired";

const APPROVAL_OUTCOME_TEXT: Record<
  ApprovalLanguage,
  Record<WhatsAppPluginApprovalOutcome, string>
> = {
  en: {
    "allow-once": "✅ Approved.",
    "allow-always": "✅ Approved, and from now on without asking.",
    deny: "❌ Rejected.",
    cancelled: "🔄 Cancelled before a decision.",
    superseded: "🔄 Updated below.",
    expired: "⏱️ Expired without an answer.",
  },
  es: {
    "allow-once": "✅ Aprobado.",
    "allow-always": "✅ Aprobado; no volveré a preguntar.",
    deny: "❌ Rechazado.",
    cancelled: "🔄 Cancelado antes de decidir.",
    superseded: "🔄 Actualizado abajo.",
    expired: "⏱️ Caducó sin respuesta.",
  },
};

const CLOSED_CARD_REACTION_TEXT: Record<ApprovalLanguage, string> = {
  en: "This card is no longer active; nothing was sent.",
  es: "Esta tarjeta ya no está activa; no se envió nada.",
};

/** The reply to a reaction on a card whose approval already ended. */
export function buildWhatsAppClosedApprovalCardReactionText(): string {
  return CLOSED_CARD_REACTION_TEXT[configuredApprovalLanguage()];
}

function configuredApprovalLanguage(): ApprovalLanguage {
  return readWhatsAppPluginConfig(getRuntimeConfig()).approvalLanguage === "es" ? "es" : "en";
}

function buildReactionHint(
  allowedDecisions: readonly ApprovalDecision[],
  language: ApprovalLanguage,
  isMessageApproval: boolean,
) {
  if (language === "en") {
    return buildApprovalReactionHint({ allowedDecisions });
  }
  const bindings = listApprovalReactionBindings({ allowedDecisions });
  if (bindings.length === 0) {
    return null;
  }
  const labels = bindings.map(
    (binding) =>
      `${binding.emoji} ${
        isMessageApproval && binding.decision === "allow-once"
          ? "Enviar"
          : SPANISH_REACTION_LABELS[binding.decision]
      }`,
  );
  return labels.join(" · ");
}

/**
 * A plugin approval as its approver reads it on a phone: what the plugin asks, the reactions that
 * answer it and the time left. The approval id, severity, plugin and agent are left out: the
 * reaction on this message is bound to the approval, so the approver needs none of them.
 */
export function buildWhatsAppPluginApprovalText(params: {
  title: string;
  description?: string | null;
  allowedDecisions: readonly ApprovalDecision[];
  expiresAtMs: number;
  nowMs: number;
}): string {
  const language = configuredApprovalLanguage();
  const isMessageApproval = params.title === MESSAGE_APPROVAL_TITLE;
  const title = language === "es" && isMessageApproval ? "¿Enviar mensaje?" : params.title;
  const minutesLeft = Math.max(1, Math.ceil((params.expiresAtMs - params.nowMs) / 60_000));
  const reactionHint = buildReactionHint(params.allowedDecisions, language, isMessageApproval);
  // Spanish cards answer on one line: the reactions, then the minutes left.
  const answer =
    language === "es"
      ? [reactionHint, `${minutesLeft} min`].filter(Boolean).join(" · ")
      : [
          reactionHint,
          `You have ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} to answer.`,
        ]
          .filter(Boolean)
          .join("\n\n");
  return [title, params.description?.trim(), answer].filter(Boolean).join("\n\n");
}

export type WhatsAppApprovalRecipientMessages = {
  personE164: string;
  messages: readonly WhatsAppUnansweredMessage[];
};

const DEFAULT_UNANSWERED_MESSAGE_LIMIT = 10;

const EARLIER_MESSAGES_TEXT: Record<ApprovalLanguage, (count: number) => string> = {
  en: (count) => `… ${count} earlier ${count === 1 ? "message" : "messages"}`,
  es: (count) => `… ${count} ${count === 1 ? "mensaje anterior" : "mensajes anteriores"}`,
};

const MEDIA_TEXT: Record<ApprovalLanguage, Record<string, string>> = {
  en: { audio: "🎤 voice message", image: "📷 photo", video: "🎥 video", document: "📎 document" },
  es: { audio: "🎤 mensaje de voz", image: "📷 foto", video: "🎥 video", document: "📎 documento" },
};
const OTHER_MEDIA_TEXT: Record<ApprovalLanguage, string> = { en: "📎 file", es: "📎 archivo" };

/**
 * Each recipient's latest unanswered messages as the approver reads them above a message card: the
 * sender, then one line per message with its time in `timeZone` (UTC when unset). The newest
 * `approvalUnansweredMessageLimit` messages are shown, and a line counts the earlier ones.
 */
export function buildWhatsAppApprovalUnansweredMessagesText(
  recipients: readonly WhatsAppApprovalRecipientMessages[],
  timeZone: string | undefined,
  nowMs: number,
): string | undefined {
  const language = configuredApprovalLanguage();
  const blocks = recipients.flatMap((recipient) =>
    recipient.messages.length > 0
      ? [buildRecipientMessagesText(recipient, language, timeZone, nowMs)]
      : [],
  );
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

const REMINDER_TEXT: Record<ApprovalLanguage, (who: string, since: string) => string> = {
  en: (who, since) => `⏳ ${who} has been waiting for an answer since ${since}.`,
  es: (who, since) => `⏳ ${who} espera respuesta desde las ${since}.`,
};

/**
 * The one reminder after a message card expired while its recipients' messages still wait: who
 * waits and since when. Undefined when nothing waits.
 */
export function buildWhatsAppApprovalReminderText(
  recipients: readonly WhatsAppApprovalRecipientMessages[],
  timeZone: string | undefined,
  nowMs: number,
): string | undefined {
  const language = configuredApprovalLanguage();
  const lines = recipients.flatMap((recipient) => {
    const earliest = recipient.messages[0];
    if (!earliest) {
      return [];
    }
    const sender = toOneLine(
      recipient.messages.findLast((message) => message.senderName)?.senderName,
    );
    const since = formatMessageTime(
      earliest.sentAtMs ?? earliest.receivedAtMs,
      nowMs,
      timeZone ?? "UTC",
      language,
    );
    return [
      REMINDER_TEXT[language](sender ?? recipient.personE164, timeZone ? since : `${since} UTC`),
    ];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildRecipientMessagesText(
  recipient: WhatsAppApprovalRecipientMessages,
  language: ApprovalLanguage,
  timeZone: string | undefined,
  nowMs: number,
): string {
  const { messages } = recipient;
  const limit =
    readWhatsAppPluginConfig(getRuntimeConfig()).approvalUnansweredMessageLimit ??
    DEFAULT_UNANSWERED_MESSAGE_LIMIT;
  const shown = messages.slice(-limit);
  const sender = toOneLine(messages.findLast((message) => message.senderName)?.senderName);
  const zone = timeZone ?? "UTC";
  const header = `📥 ${sender ? `${sender} · ` : ""}${recipient.personE164}${timeZone ? "" : " · UTC"}`;
  const earlier = messages.length - shown.length;
  return [
    header,
    ...(earlier > 0 ? [EARLIER_MESSAGES_TEXT[language](earlier)] : []),
    ...shown.map((message) => {
      const at = message.sentAtMs ?? message.receivedAtMs;
      const content =
        toOneLine(message.text) ||
        (message.mediaKind
          ? (MEDIA_TEXT[language][message.mediaKind] ?? OTHER_MEDIA_TEXT[language])
          : OTHER_MEDIA_TEXT[language]);
      return `${formatMessageTime(at, nowMs, zone, language)} ${content}`;
    }),
  ].join("\n");
}

/**
 * A guest's text as one line: the guest writes it, so a line break in it must not draw lines that
 * read as the card's own title, proposal or reactions.
 */
const toOneLine = (text: string | undefined): string | undefined =>
  text?.replace(/\s+/g, " ").trim() || undefined;

/** `16:15` for a message of today in the zone, `19 oct 16:15` for an earlier day. */
function formatMessageTime(
  atMs: number,
  nowMs: number,
  timeZone: string,
  language: ApprovalLanguage,
): string {
  const locale = language === "es" ? "es-MX" : "en-US";
  const day = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(ms);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(atMs);
  if (day(atMs) === day(nowMs)) {
    return time;
  }
  const date = new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: "short" }).format(
    atMs,
  );
  return `${date} ${time}`;
}

/** How a plugin approval ended, written over its card. */
export function buildWhatsAppPluginApprovalOutcomeText(
  outcome: WhatsAppPluginApprovalOutcome,
): string {
  return APPROVAL_OUTCOME_TEXT[configuredApprovalLanguage()][outcome];
}
