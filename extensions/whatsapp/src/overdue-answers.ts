import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { isWhatsAppCommandOwner, normalizeWhatsAppDirectId } from "./command-owner.js";
import type { WhatsAppInboundAdmission } from "./inbound/admission.js";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";
import { createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getWhatsAppRuntime } from "./runtime.js";

/**
 * A person's answer is overdue when their earliest message that no answer and no turn handled was
 * sent more than this before now. Same fence as iMessage's
 * `IMESSAGE_STALE_INBOUND_THRESHOLD_MS`.
 */
const WHATSAPP_OVERDUE_ANSWER_THRESHOLD_MS = 15 * 60 * 1000;

const UNANSWERED_NAMESPACE = "whatsapp.unanswered-messages";
/** Bounds the store across all accounts; the least recently written person goes first. */
const UNANSWERED_MAX_PEOPLE = 10_000;
/** A person nobody wrote to and who wrote nothing for this long is forgotten. */
const UNANSWERED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds one person's record; later messages past it change nothing the rule reads. */
const UNANSWERED_MAX_MESSAGES = 100;

/** An overdue answer: the earliest unanswered message's send time, absent when WhatsApp gave none. */
export type WhatsAppOverdueAnswer = { earliestSentAtMs?: number };

type UnansweredMessage = {
  id?: string;
  /** WhatsApp `messageTimestamp`; absent when WhatsApp gave none. */
  sentAtMs?: number;
  receivedAtMs: number;
};

/** One person's state on one account, as stored. */
type WhatsAppAnswerState = {
  /** The person's messages sent after the latest answer, earliest first. */
  unanswered: UnansweredMessage[];
  /** When the latest message from the business number to the person was sent. */
  answeredAtMs?: number;
};

type AnswerStateStore = {
  register(key: string, value: WhatsAppAnswerState): Promise<void>;
  lookup(key: string): Promise<WhatsAppAnswerState | undefined>;
  entries(): Promise<Array<{ key: string; value: WhatsAppAnswerState }>>;
};

const openStoreForRuntime = createPerRuntimeStoreOpener((runtime): AnswerStateStore =>
  runtime.state.openKeyedStore<WhatsAppAnswerState>({
    namespace: UNANSWERED_NAMESPACE,
    maxEntries: UNANSWERED_MAX_PEOPLE,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: UNANSWERED_TTL_MS,
  }),
);

const openAnswerStateStore = (): AnswerStateStore => openStoreForRuntime(getWhatsAppRuntime());

/** One person on one account. */
export type WhatsAppAnswerPerson = { accountId: string; personE164: string };

// Keys are JSON arrays, so one account's number cannot match another account's key.
const buildKey = (person: WhatsAppAnswerPerson): string =>
  JSON.stringify([person.accountId, person.personE164]);

// The channel runtime writes from inbound and send paths that run concurrently, so writes of one
// key are serialized; the chain is process-global because the plugin loads in several module
// instances.
const writeChains = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.whatsapp-for-business.unansweredMessageWrites"),
);

async function updateAnswerState(
  person: WhatsAppAnswerPerson,
  change: (current: WhatsAppAnswerState | undefined) => WhatsAppAnswerState | undefined,
): Promise<void> {
  const key = buildKey(person);
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    const store = openAnswerStateStore();
    const updated = change(await store.lookup(key));
    if (updated) {
      await store.register(key, updated);
    }
  });
  const settled = next.catch(() => {});
  writeChains.set(key, settled);
  void settled.then(() => {
    if (writeChains.get(key) === settled) {
      writeChains.delete(key);
    }
  });
  await next;
}

/** The time that orders a message against answers: its send time, else when it arrived. */
const orderingTimeMs = (message: UnansweredMessage): number =>
  message.sentAtMs ?? message.receivedAtMs;

/**
 * The person whose answers a direct chat's message tracks, as E.164: none for groups, the
 * account's own chat, an owner turn of the linked phone's own message, and the command owners,
 * because everything sent to them reaches the owner already.
 */
export function resolveWhatsAppAnswerPerson(params: {
  admission: WhatsAppInboundAdmission;
  senderE164: string | undefined;
  isOwnMessageTurn: boolean;
  cfg: OpenClawConfig;
}): WhatsAppAnswerPerson | undefined {
  const { admission } = params;
  if (admission.conversation.kind !== "direct" || admission.isSelfChat || params.isOwnMessageTurn) {
    return undefined;
  }
  const personE164 = normalizeWhatsAppDirectId(params.senderE164 ?? admission.conversation.id);
  if (!personE164 || isWhatsAppCommandOwner(params.cfg, personE164)) {
    return undefined;
  }
  return { accountId: admission.accountId, personE164 };
}

/**
 * Records a message from the person. A message sent before the latest answer is already answered;
 * a message already recorded is kept once.
 */
export async function recordWhatsAppUnansweredMessage(
  person: WhatsAppAnswerPerson,
  message: UnansweredMessage,
): Promise<void> {
  await updateAnswerState(person, (current) => {
    const state = current ?? { unanswered: [] };
    if (state.answeredAtMs !== undefined && orderingTimeMs(message) <= state.answeredAtMs) {
      return undefined;
    }
    if (message.id !== undefined && state.unanswered.some((known) => known.id === message.id)) {
      return undefined;
    }
    const unanswered = [...state.unanswered, message]
      .toSorted((a, b) => orderingTimeMs(a) - orderingTimeMs(b))
      .slice(0, UNANSWERED_MAX_MESSAGES);
    return { ...state, unanswered };
  });
}

/**
 * Records a message from the business number delivered to the person at `answeredAtMs`: it answers
 * every message of theirs sent before it.
 */
export async function recordWhatsAppAnswer(
  person: WhatsAppAnswerPerson,
  answeredAtMs: number,
): Promise<void> {
  await updateAnswerState(person, (current) => answerUpTo(current, answeredAtMs));
}

function answerUpTo(
  current: WhatsAppAnswerState | undefined,
  answeredAtMs: number,
): WhatsAppAnswerState | undefined {
  if (current?.answeredAtMs !== undefined && current.answeredAtMs >= answeredAtMs) {
    return undefined;
  }
  return {
    unanswered: (current?.unanswered ?? []).filter(
      (message) => orderingTimeMs(message) > answeredAtMs,
    ),
    answeredAtMs,
  };
}

// The latest send time of the person's messages that joined the person's running turn (queue mode
// `steer`); that turn's end handles them. Process-global for the same reason as `writeChains`.
const steeredMessages = resolveGlobalMap<string, number>(
  Symbol.for("openclaw.whatsapp-for-business.steeredMessages"),
);

// The sessions whose turn put, or tried to put, something in front of anyone on WhatsApp since the
// session's last turn end, the owner included. A turn the plugin does not end (a core follow-up)
// leaves its send to the next turn end, which then handles nothing. Process-global for the same
// reason as `writeChains`.
const sessionsWithTurnSend = resolveGlobalMap<string, true>(
  Symbol.for("openclaw.whatsapp-for-business.sessionsWithTurnSend"),
);

const normalizeSessionKey = (sessionKey: string) => sessionKey.trim().toLowerCase();

/** Records a send, or an attempt at one, by the session's running turn. */
export function recordWhatsAppTurnSend(sessionKey: string): void {
  sessionsWithTurnSend.set(normalizeSessionKey(sessionKey), true);
}

/** Whether the session's turn sent, or tried to send, anything; forgets it. */
export function consumeWhatsAppTurnSend(sessionKey: string): boolean {
  return sessionsWithTurnSend.delete(normalizeSessionKey(sessionKey));
}

/** Records a message of the person that joined the person's running turn instead of starting one. */
export function recordWhatsAppMessageSteered(person: WhatsAppAnswerPerson, sentAtMs: number): void {
  const key = buildKey(person);
  steeredMessages.set(key, Math.max(steeredMessages.get(key) ?? sentAtMs, sentAtMs));
}

/**
 * Records the end of a turn of the person that started before the answer was overdue. A turn that
 * sent nothing to anyone chose silence: the messages it read, its own and those that joined it,
 * need no answer. A turn that sent or tried to send leaves them as they are: a delivered answer
 * already answered them, and a handoff to the owner, a refused or an unapproved send leave them
 * waiting. A turn that ends after the answer became overdue handles nothing: the owner decides.
 * True when the turn handled the messages it read.
 */
export async function recordWhatsAppTurnEnded(
  person: WhatsAppAnswerPerson,
  turn: { sentAtMs: number | undefined; sent: boolean },
  nowMs: number,
): Promise<boolean> {
  const key = buildKey(person);
  const steeredSentAtMs = steeredMessages.get(key);
  steeredMessages.delete(key);
  const readSentAtMs = [turn.sentAtMs, steeredSentAtMs].filter((at) => at !== undefined);
  if (turn.sent || readSentAtMs.length === 0) {
    return false;
  }
  let handled = false;
  await updateAnswerState(person, (current) => {
    if (decideOverdueAnswer(current, nowMs)) {
      return undefined;
    }
    handled = true;
    return answerUpTo(current, Math.max(...readSentAtMs));
  });
  return handled;
}

function decideOverdueAnswer(
  state: WhatsAppAnswerState | undefined,
  nowMs: number,
): WhatsAppOverdueAnswer | undefined {
  const unanswered = state?.unanswered ?? [];
  const known = unanswered.flatMap((message) =>
    message.sentAtMs !== undefined ? [message.sentAtMs] : [],
  );
  const earliestSentAtMs = known.length > 0 ? Math.min(...known) : undefined;
  // A message without a send time cannot prove it is not overdue.
  const isOverdue =
    known.length < unanswered.length ||
    (earliestSentAtMs !== undefined &&
      nowMs - earliestSentAtMs > WHATSAPP_OVERDUE_ANSWER_THRESHOLD_MS);
  if (!isOverdue) {
    return undefined;
  }
  return earliestSentAtMs !== undefined ? { earliestSentAtMs } : {};
}

/** The person's overdue answer at `nowMs`, or undefined when nothing of theirs is overdue. */
export async function readWhatsAppOverdueAnswer(
  person: WhatsAppAnswerPerson,
  nowMs: number,
): Promise<WhatsAppOverdueAnswer | undefined> {
  if (!isWhatsAppOverdueAnswerBlockingEnabled()) {
    return undefined;
  }
  return decideOverdueAnswer(await openAnswerStateStore().lookup(buildKey(person)), nowMs);
}

/** Every person whose answer is overdue at `nowMs`, on any account. */
export async function listWhatsAppOverdueAnswers(
  nowMs: number,
): Promise<Array<WhatsAppAnswerPerson & { overdue: WhatsAppOverdueAnswer }>> {
  if (!isWhatsAppOverdueAnswerBlockingEnabled()) {
    return [];
  }
  return (await openAnswerStateStore().entries()).flatMap((entry) => {
    const overdue = decideOverdueAnswer(entry.value, nowMs);
    // SAFETY: this store's only key writer is buildKey, a JSON [accountId, personE164] pair.
    const [accountId, personE164] = JSON.parse(entry.key) as [string, string];
    return overdue ? [{ accountId, personE164, overdue }] : [];
  });
}

export function isWhatsAppOverdueAnswerBlockingEnabled(): boolean {
  return (
    getRuntimeConfig().plugins?.entries?.[WHATSAPP_FOR_BUSINESS_PLUGIN_ID]?.config
      ?.blockOverdueAnswers !== false
  );
}

const THRESHOLD_MINUTES = WHATSAPP_OVERDUE_ANSWER_THRESHOLD_MS / 60_000;

/** When the overdue message was sent, for the model and the logs. */
export function formatWhatsAppOverdueSince(overdue: WhatsAppOverdueAnswer): string {
  return overdue.earliestSentAtMs !== undefined
    ? new Date(overdue.earliestSentAtMs).toISOString()
    : "an unknown time (WhatsApp gave no send time)";
}

/** Why only the owner may be written to while the person's answer is overdue, for the model. */
export function describeWhatsAppOverdueAnswerRule(overdue: WhatsAppOverdueAnswer): string {
  return (
    `The answer to this person is overdue: their earliest unanswered WhatsApp message, sent ` +
    `${formatWhatsAppOverdueSince(overdue)}, has waited more than ${THRESHOLD_MINUTES} minutes. ` +
    `Nothing can be sent to this person; only the owner can be written to (message target ` +
    `"owner"). An answer the owner sends or orders from the owner's own chat ends this.`
  );
}
