import {
  buildApprovalReactionHint,
  listApprovalReactionBindings,
  type ApprovalReactionDecisionBinding,
} from "openclaw/plugin-sdk/approval-reaction-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
  SystemAgentApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentIdFromSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import {
  getSessionEntryAsync,
  loadTranscriptEventsSync,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readWhatsAppPluginConfig } from "./plugin-config.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

type ApprovalDecision = ApprovalReactionDecisionBinding["decision"];
type ApprovalLanguage = "en" | "es";

const DEFAULT_UNANSWERED_MESSAGE_LIMIT = 10;
/** A guest message on the card is cut to this many characters; the proposed text never is. */
const UNANSWERED_MESSAGE_MAX_LENGTH = 300;
/** The `message` tool arguments the card shows in its own lines, not as `name: value`. */
const SHOWN_ARGUMENTS = new Set([
  "action",
  "target",
  "to",
  "targets",
  "message",
  "requestApproval",
]);

const CARD_TEXT = {
  en: {
    title: "Send message?",
    actionTitle: (action: string) => `Message action "${action}"?`,
    to: "To",
    noText: "(no text)",
    send: "Send",
    earlier: (count: number) => `… ${count} earlier ${count === 1 ? "message" : "messages"}`,
    minutes: (count: number) =>
      `You have ${count} ${count === 1 ? "minute" : "minutes"} to answer.`,
  },
  es: {
    title: "¿Enviar mensaje?",
    actionTitle: (action: string) => `¿Acción de mensaje "${action}"?`,
    to: "Para",
    noText: "(sin texto)",
    send: "Enviar",
    earlier: (count: number) =>
      `… ${count} ${count === 1 ? "mensaje anterior" : "mensajes anteriores"}`,
    minutes: (count: number) => `${count} min`,
  },
} satisfies Record<ApprovalLanguage, unknown>;

const SPANISH_DECISION_LABELS: Record<ApprovalDecision, string> = {
  "allow-once": "Aprobar una vez",
  "allow-always": "Aprobar siempre",
  deny: "Rechazar",
};

/** How a card ended: a decision, its expiry, or a business reply to the same guest that made it stale. */
export type WhatsAppMessageCardOutcome = ApprovalDecision | "expired" | "answered";

const OUTCOME_TEXT: Record<ApprovalLanguage, Record<WhatsAppMessageCardOutcome, string>> = {
  en: {
    "allow-once": "✅ Approved.",
    "allow-always": "✅ Approved, and from now on without asking.",
    deny: "❌ Rejected.",
    expired: "⏱️ Expired without an answer.",
    answered: "↪️ Already answered.",
  },
  es: {
    "allow-once": "✅ Aprobado.",
    "allow-always": "✅ Aprobado; no volveré a preguntar.",
    deny: "❌ Rechazado.",
    expired: "⏱️ Caducó sin respuesta.",
    answered: "↪️ Ya respondido.",
  },
};

/** A transcript message as the card reads it; a tool result also names its call. */
type AgentMessage = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
  customType?: string;
  provider?: string;
  model?: string;
  timestamp?: number;
};

type ProposedSend = {
  arguments: Record<string, unknown>;
  recipient?: string;
  /** The guest's messages after the business's last delivered reply, earliest first. */
  unanswered: { atMs?: number; text: string }[];
};

/** Whether a plugin approval asks to run the `message` tool, the only approval with a card. */
export function isWhatsAppMessageApproval(
  request: ExecApprovalRequest | PluginApprovalRequest | SystemAgentApprovalRequest,
): request is PluginApprovalRequest {
  return "toolName" in request.request && request.request.toolName === "message";
}

function approvalLanguage(cfg: OpenClawConfig): ApprovalLanguage {
  return readWhatsAppPluginConfig(cfg).approvalLanguage === "es" ? "es" : "en";
}

function messageText(message: AgentMessage): string {
  const { content } = message;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text")
        .map((part) => part.text)
        .join("\n")
    : "";
}

type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };

function toolCalls(message: AgentMessage): ToolCall[] {
  const { content } = message;
  return Array.isArray(content)
    ? content.filter((part): part is ToolCall & { type: "toolCall" } => part?.type === "toolCall")
    : [];
}

/** A tool result's JSON `status`; the `message` tool reports a refused or failed send there. */
function resultStatus(message: AgentMessage): unknown {
  try {
    return (JSON.parse(messageText(message)) as { status?: unknown }).status;
  } catch {
    return undefined;
  }
}

/** A message of the session transcript; other transcript events (settings, snapshots) are skipped. */
type TranscriptMessage = { role: string; message: AgentMessage; atMs?: number };

type TranscriptEvent = {
  id?: string;
  parentId?: string | null;
  type?: unknown;
  message?: AgentMessage;
  timestamp?: unknown;
};

const holdsCall = (event: TranscriptEvent, toolCallId: string): boolean =>
  event.type === "message" &&
  event.message?.role === "assistant" &&
  toolCalls(event.message).some((call) => call.id === toolCallId);

/**
 * The messages of the transcript branch that ends with the call, earliest first: from the last
 * event holding the call back through `parentId`, so a retried or abandoned branch is left out.
 * Empty when the transcript does not hold the call.
 */
function readTranscriptBranch(
  events: readonly unknown[],
  toolCallId?: string,
): TranscriptMessage[] {
  const all = events as readonly TranscriptEvent[];
  const byId = new Map(all.flatMap((event) => (event.id ? [[event.id, event] as const] : [])));
  const branch: TranscriptEvent[] = [];
  const seen = new Set<TranscriptEvent>();
  for (
    let event = toolCallId
      ? all.findLast((candidate) => holdsCall(candidate, toolCallId))
      : all.at(-1);
    event && !seen.has(event);
    event = event.parentId ? byId.get(event.parentId) : undefined
  ) {
    seen.add(event);
    branch.unshift(event);
  }
  return branch.flatMap(({ type, message, timestamp }) =>
    type === "message" && message
      ? [
          {
            role: message.role,
            message,
            atMs:
              message.timestamp ??
              (typeof timestamp === "string" ? Date.parse(timestamp) : undefined),
          },
        ]
      : [],
  );
}

function isDeliveredSend(entry: TranscriptMessage, sendIds: Set<string>): boolean {
  const result = entry.message;
  return (
    entry.role === "toolResult" &&
    sendIds.has(result.toolCallId ?? "") &&
    result.isError !== true &&
    resultStatus(entry.message) !== "error"
  );
}

/**
 * The `message` call an approval holds, read from the session transcript through the public
 * session store API; OpenClaw stores the assistant's tool call before it asks for approval.
 * Undefined when the session or the call is gone.
 */
async function readProposedSend(
  cfg: OpenClawConfig,
  request: PluginApprovalRequest,
): Promise<ProposedSend | undefined> {
  const { sessionKey, toolCallId } = request.request;
  if (!sessionKey || !toolCallId) {
    return undefined;
  }
  const agentId = request.request.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const session = await getSessionEntryAsync({ agentId, sessionKey });
  if (!session?.sessionId) {
    return undefined;
  }
  let entries = readTranscriptBranch(
    loadTranscriptEventsSync({ agentId, sessionKey, sessionId: session.sessionId }),
    toolCallId,
  );
  const pending = entries
    .flatMap((entry) => toolCalls(entry.message))
    .findLast((call) => call.id === toolCallId);
  if (!pending) {
    return undefined;
  }
  const resolveRecipient = (args: Record<string, unknown>, fallback?: string | null) => {
    if (args.channel && args.channel !== "whatsapp") {
      return undefined;
    }
    const target = args.target ?? args.to ?? fallback;
    if (typeof target !== "string") {
      return undefined;
    }
    const resolved = resolveWhatsAppOutboundTarget({
      cfg,
      to: target,
      allowFrom: undefined,
      mode: "explicit",
    });
    return resolved.ok ? resolved.to : undefined;
  };
  const source = resolveRecipient({}, request.request.turnSourceTo);
  const recipient = resolveRecipient(pending.arguments, request.request.turnSourceTo);
  const accountId =
    typeof pending.arguments.accountId === "string"
      ? pending.arguments.accountId
      : (request.request.turnSourceAccountId ?? undefined);
  if (recipient !== source || accountId !== (request.request.turnSourceAccountId ?? undefined)) {
    entries = [];
    if (recipient) {
      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId,
        peer: { kind: recipient.endsWith("@g.us") ? "group" : "direct", id: recipient },
      });
      const destination = await getSessionEntryAsync({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      });
      if (destination?.sessionId) {
        entries = readTranscriptBranch(
          loadTranscriptEventsSync({
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            sessionId: destination.sessionId,
          }),
        );
      }
    }
  }
  const sendIds = new Set<string>();
  let unanswered: ProposedSend["unanswered"] = [];
  let lastReplyAt = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (
      isDeliveredSend(entry, sendIds) ||
      (entry.role === "custom" && entry.message.customType === "whatsapp.history") ||
      (entry.role === "assistant" &&
        entry.message.provider === "openclaw" &&
        entry.message.model === "delivery-mirror")
    ) {
      if (entry.atMs !== undefined && Number.isFinite(entry.atMs)) {
        lastReplyAt = Math.max(lastReplyAt, entry.atMs);
        unanswered = unanswered.filter(
          (message) => message.atMs !== undefined && message.atMs > lastReplyAt,
        );
      } else {
        unanswered = [];
      }
      continue;
    }
    if (
      entry.role === "user" ||
      (entry.role === "custom" && entry.message.customType === "whatsapp.inbound-history")
    ) {
      const text = messageText(entry.message).trim();
      if (text && (entry.atMs === undefined || entry.atMs > lastReplyAt)) {
        unanswered.push({ atMs: entry.atMs, text });
      }
      continue;
    }
    if (entry.role === "assistant") {
      for (const call of toolCalls(entry.message)) {
        if (
          call.name === "message" &&
          (call.arguments?.action ?? "send") === "send" &&
          resolveRecipient(call.arguments, recipient) === recipient &&
          (typeof call.arguments.accountId !== "string" || call.arguments.accountId === accountId)
        ) {
          sendIds.add(call.id);
        }
      }
      continue;
    }
  }
  unanswered.sort((left, right) => (left.atMs ?? 0) - (right.atMs ?? 0));
  return { arguments: pending.arguments, recipient, unanswered };
}

/**
 * Shows the characters a phone does not draw - controls, format and bidi marks, unassigned code
 * points, and the blank letters (Hangul fillers, the blank braille pattern) - as `\u{…}` codes,
 * so a text cannot hide or reorder what the approver reads. A line break and the emoji joiner stay.
 */
function visible(text: string): string {
  return text.replace(
    /(?![\n\u200d])[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u2800\u3164\uffa0]/gu,
    (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`,
  );
}

function oneLine(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  const line = (typeof value === "string" ? value : JSON.stringify(value))
    .replace(/\s+/g, " ")
    .trim();
  return visible(line.length > maxLength ? `${line.slice(0, maxLength)}…` : line);
}

function formatTime(atMs: number | undefined, timeZone: string | undefined): string {
  return atMs === undefined || Number.isNaN(atMs)
    ? ""
    : new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }).format(
        atMs,
      );
}

function buildReactionLine(
  allowedDecisions: readonly ApprovalDecision[],
  language: ApprovalLanguage,
  minutesLeft: number,
): string {
  const text = CARD_TEXT[language];
  if (language === "en") {
    return [buildApprovalReactionHint({ allowedDecisions }), text.minutes(minutesLeft)]
      .filter(Boolean)
      .join("\n\n");
  }
  const labels = listApprovalReactionBindings({ allowedDecisions }).map(
    (binding) =>
      `${binding.emoji} ${binding.decision === "allow-once" ? text.send : SPANISH_DECISION_LABELS[binding.decision]}`,
  );
  return [...labels, text.minutes(minutesLeft)].join(" · ");
}

/**
 * The card of a `message` approval, as the approver reads it on a phone: the guest's unanswered
 * messages, then the proposed send - recipient, text, every other argument - then the Guardian's
 * question and the reactions that answer, the card's last block (`footer`), which its outcome
 * replaces. Undefined when the transcript does not hold the call.
 */
export async function buildWhatsAppMessageCard(params: {
  cfg: OpenClawConfig;
  request: PluginApprovalRequest;
  allowedDecisions: readonly ApprovalDecision[];
  nowMs: number;
}): Promise<{ text: string; footer: string } | undefined> {
  const send = await readProposedSend(params.cfg, params.request);
  if (!send) {
    return undefined;
  }
  const language = approvalLanguage(params.cfg);
  const text = CARD_TEXT[language];
  const limit =
    readWhatsAppPluginConfig(params.cfg).approvalUnansweredMessageLimit ??
    DEFAULT_UNANSWERED_MESSAGE_LIMIT;
  const timeZone = params.cfg.agents?.defaults?.userTimezone;
  const shown = send.unanswered.slice(-limit);
  const earlier = send.unanswered.length - shown.length;
  const source = params.request.request.turnSourceTo;
  const history =
    shown.length > 0
      ? [
          `📥 ${send.recipient ?? ""}`.trim(),
          ...(earlier > 0 ? [text.earlier(earlier)] : []),
          ...shown.map((message) =>
            [
              formatTime(message.atMs, timeZone),
              oneLine(message.text, UNANSWERED_MESSAGE_MAX_LENGTH),
            ]
              .filter(Boolean)
              .join(" "),
          ),
        ].join("\n")
      : undefined;

  const args = send.arguments;
  // Only a send is a message; any other action (react, delete, edit) names itself on the card.
  const action = typeof args.action === "string" && args.action !== "" ? args.action : "send";
  const targets = [args.target, args.to, ...(Array.isArray(args.targets) ? args.targets : [])]
    .filter((target) => target !== undefined && target !== null && target !== "")
    .map((target) => oneLine(target));
  const recipients = targets.length > 0 ? targets : source ? [source] : [];
  // OpenClaw turns a literal "\n" into a line break before it sends (message-action-send.ts).
  const body =
    typeof args.message === "string" ? visible(args.message.replaceAll("\\n", "\n").trim()) : "";
  const others = Object.entries(args)
    .filter(([name, value]) => !SHOWN_ARGUMENTS.has(name) && value !== undefined && value !== null)
    .map(([name, value]) => `${name}: ${oneLine(value)}`);

  const minutesLeft = Math.max(1, Math.ceil((params.request.expiresAtMs - params.nowMs) / 60_000));
  const footer = buildReactionLine(params.allowedDecisions, language, minutesLeft);
  const cardText = [
    history,
    action === "send" ? text.title : text.actionTitle(action),
    `${text.to}: ${recipients.join(", ")}`,
    body || (others.length > 0 || action !== "send" ? undefined : text.noText),
    others.length > 0 ? others.join("\n") : undefined,
    params.request.request.description?.trim(),
    footer,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text: cardText, footer };
}

/** How a message card ended, in the card's language. */
export function buildWhatsAppMessageCardOutcomeText(
  cfg: OpenClawConfig,
  outcome: WhatsAppMessageCardOutcome,
): string {
  return OUTCOME_TEXT[approvalLanguage(cfg)][outcome];
}
