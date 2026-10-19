import {
  buildApprovalReactionHint,
  listApprovalReactionBindings,
  type ApprovalReactionDecisionBinding,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";

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

const APPROVAL_OUTCOME_TEXT: Record<
  ApprovalLanguage,
  Record<ApprovalDecision | "expired", string>
> = {
  en: {
    "allow-once": "✅ Approved.",
    "allow-always": "✅ Approved, and from now on without asking.",
    deny: "❌ Not run.",
    expired: "⏱️ Approval expired: not run. Request a new proposal to continue.",
  },
  es: {
    "allow-once": "✅ Aprobado.",
    "allow-always": "✅ Aprobado; no volveré a preguntar.",
    deny: "❌ No se ejecutó.",
    expired: "⏱️ La aprobación caducó: no se ejecutó. Solicita una nueva propuesta para continuar.",
  },
};

function configuredApprovalLanguage(): ApprovalLanguage {
  const configured =
    getRuntimeConfig().plugins?.entries?.[WHATSAPP_FOR_BUSINESS_PLUGIN_ID]?.config
      ?.approvalLanguage;
  return configured === "es" ? "es" : "en";
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
  return `Reacciona con:\n\n${labels.join("\n")}`;
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
  const timeLeft =
    language === "es"
      ? `Tienes ${minutesLeft} ${minutesLeft === 1 ? "minuto" : "minutos"} para responder.`
      : `You have ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} to answer.`;
  return [title, params.description?.trim(), reactionHint, timeLeft].filter(Boolean).join("\n\n");
}

/** How a plugin approval ended, sent as a reply to its prompt. */
export function buildWhatsAppPluginApprovalOutcomeText(
  outcome: ApprovalDecision | "expired",
): string {
  return APPROVAL_OUTCOME_TEXT[configuredApprovalLanguage()][outcome];
}
