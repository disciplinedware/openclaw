import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { WHATSAPP_OVERDUE_ANSWER_THRESHOLD_MS } from "./overdue-answers.js";
import { createKeyedWriteQueue, createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getOptionalWhatsAppRuntime, getWhatsAppRuntime } from "./runtime.js";

/** A delivered message approval card, as the plugin needs it after its approval ends. */
export type WhatsAppApprovalCard = {
  accountId: string;
  /** The approver's chat that shows the card. */
  remoteJid: string;
  messageId: string;
  /** The E.164 numbers the proposed message goes to. */
  recipients: string[];
  /** The session whose run proposed the message. */
  sourceSessionKey?: string;
  /** The run that proposed the message. */
  sourceRunId?: string;
  /** The card's proposal as the approver read it. */
  description?: string;
};

/** A proposal whose run stopped before the approver decided, so nothing was sent. */
export type WhatsAppCancelledProposal = {
  recipients: string[];
  description?: string;
  cancelledAtMs: number;
};

/** A session's proposal from the delivery of its card until a decision or expiry ends it. */
type StoredProposal = {
  cardMessageId: string;
  recipients: string[];
  description?: string;
  /** Absent while the card is open. */
  cancelledAtMs?: number;
};

type StoredCards = {
  /** Cards in one approver chat cancelled before a decision, until a newer card replaces them. */
  cancelled?: WhatsAppApprovalCard[];
  /** Set on a card whose approval ended, so a later reaction on it gets an answer. */
  closed?: true;
  /** One session's open and cancelled proposals, for its next turn. */
  proposals?: StoredProposal[];
};

const CARDS_MAX_ENTRIES = 5_000;
const CARDS_TTL_MS = 24 * 60 * 60 * 1000;

const openStoreForRuntime = createPerRuntimeStoreOpener((runtime) =>
  runtime.state.openKeyedStore<StoredCards>({
    namespace: "whatsapp.approval-cards",
    maxEntries: CARDS_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: CARDS_TTL_MS,
  }),
);
const openStore = () => openStoreForRuntime(getWhatsAppRuntime());
// Reads run on every inbound message and reaction, also in a process that has not loaded the
// plugin's runtime yet; such a process has no cards to read.
const lookupStored = async (key: string): Promise<StoredCards | undefined> => {
  const runtime = getOptionalWhatsAppRuntime();
  return runtime ? await openStoreForRuntime(runtime).lookup(key) : undefined;
};
const queueWrite = createKeyedWriteQueue("openclaw.whatsapp-for-business.approvalCardWrites");

// Keys are JSON arrays, so one account's or chat's values cannot match another's key.
const closedKey = (accountId: string, remoteJid: string, messageId: string) =>
  JSON.stringify(["closed", accountId, remoteJid, messageId]);
const cancelledKey = (accountId: string, remoteJid: string) =>
  JSON.stringify(["cancelled", accountId, remoteJid]);
const proposalsKey = (sessionKey: string) => JSON.stringify(["proposals", sessionKey]);

async function update(
  key: string,
  change: (current: StoredCards | undefined) => StoredCards | undefined,
): Promise<void> {
  await queueWrite(key, async () => {
    const store = openStore();
    const updated = change(await store.lookup(key));
    if (updated) {
      await store.register(key, updated);
    }
  });
}

const sharesRecipient = (recipients: readonly string[], other: readonly string[]) =>
  recipients.some((recipient) => other.includes(recipient));

/** Records a delivered card's proposal for the session that proposed it, until the card closes. */
export async function recordWhatsAppApprovalCardDelivered(
  card: WhatsAppApprovalCard,
): Promise<void> {
  if (!card.sourceSessionKey) {
    return;
  }
  await update(proposalsKey(card.sourceSessionKey), (current) => ({
    proposals: [
      ...(current?.proposals ?? []).filter((known) => known.cardMessageId !== card.messageId),
      { cardMessageId: card.messageId, recipients: card.recipients, description: card.description },
    ],
  }));
}

/**
 * Records the end of a card's approval. A card cancelled before a decision waits in its chat for
 * the next card to the same recipient, which replaces it, and its proposal waits for the next turn
 * of the session that proposed it.
 */
export async function recordWhatsAppApprovalCardClosed(
  card: WhatsAppApprovalCard,
  outcome: "decided" | "cancelled" | "expired",
  nowMs: number,
): Promise<void> {
  await update(closedKey(card.accountId, card.remoteJid, card.messageId), () => ({ closed: true }));
  if (card.sourceSessionKey) {
    // A proposal already gone was proposed again by a newer card; its cancellation adds nothing.
    await update(proposalsKey(card.sourceSessionKey), (current) =>
      current?.proposals
        ? {
            proposals: current.proposals.flatMap((known) =>
              known.cardMessageId !== card.messageId
                ? [known]
                : outcome === "cancelled"
                  ? [{ ...known, cancelledAtMs: nowMs }]
                  : [],
            ),
          }
        : undefined,
    );
  }
  if (outcome !== "cancelled") {
    return;
  }
  await update(cancelledKey(card.accountId, card.remoteJid), (current) => ({
    cancelled: [
      ...(current?.cancelled ?? []).filter((known) => known.messageId !== card.messageId),
      card,
    ],
  }));
}

/** Whether the card's approval already ended. */
export async function isWhatsAppApprovalCardClosed(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): Promise<boolean> {
  const stored = await lookupStored(
    closedKey(params.accountId, params.remoteJid, params.messageId),
  );
  return stored?.closed === true;
}

/**
 * The cancelled cards that a new card replaces, forgotten once read: those in its chat for any of its recipients.
 * The new card's proposal also settles its session's cancelled proposals to those recipients.
 */
export async function consumeWhatsAppApprovalCardsReplacedBy(
  card: WhatsAppApprovalCard,
): Promise<WhatsAppApprovalCard[]> {
  let replaced: WhatsAppApprovalCard[] = [];
  await update(cancelledKey(card.accountId, card.remoteJid), (current) => {
    const cancelled = current?.cancelled ?? [];
    replaced = cancelled.filter((known) => sharesRecipient(known.recipients, card.recipients));
    return replaced.length > 0
      ? { cancelled: cancelled.filter((known) => !replaced.includes(known)) }
      : undefined;
  });
  if (card.sourceSessionKey) {
    await update(proposalsKey(card.sourceSessionKey), (current) =>
      current?.proposals
        ? {
            proposals: current.proposals.filter(
              (proposal) => !sharesRecipient(proposal.recipients, card.recipients),
            ),
          }
        : undefined,
    );
  }
  return replaced;
}

/**
 * At the start of a session's turn, the proposals of its earlier runs that no approver decided and
 * that were not proposed again, earliest first. A card still open belongs to a run that already
 * ended, since a session runs one turn at a time: the run's end is cancelling its approval, and
 * the cancellation may not be recorded yet. A proposal older than the overdue-answer threshold is
 * left to the approver.
 */
export async function readWhatsAppCancelledProposals(
  sessionKey: string,
  nowMs: number,
): Promise<WhatsAppCancelledProposal[]> {
  const stored = await lookupStored(proposalsKey(sessionKey));
  return (stored?.proposals ?? [])
    .map(({ recipients, description, cancelledAtMs }) => {
      const proposal: WhatsAppCancelledProposal = {
        recipients,
        cancelledAtMs: cancelledAtMs ?? nowMs,
      };
      if (description !== undefined) {
        proposal.description = description;
      }
      return proposal;
    })
    .filter((proposal) => nowMs - proposal.cancelledAtMs <= WHATSAPP_OVERDUE_ANSWER_THRESHOLD_MS);
}

// Approvals the approver's reaction is resolving: a deny among them is the approver's rejection,
// any other deny a cancellation. Process-global because the plugin loads in several module
// instances.
const approvalsDecidedByReaction = resolveGlobalMap<string, true>(
  Symbol.for("openclaw.whatsapp-for-business.approvalsDecidedByReaction"),
);

/** Records that the approver's reaction is resolving the approval. */
export function recordWhatsAppApprovalReactionDecision(approvalId: string): void {
  approvalsDecidedByReaction.set(approvalId, true);
}

/** Forgets a reaction that resolved nothing. */
export function forgetWhatsAppApprovalReactionDecision(approvalId: string): void {
  approvalsDecidedByReaction.delete(approvalId);
}

/** Whether the approver's reaction resolved the approval; forgets it. */
export function consumeWhatsAppApprovalReactionDecision(approvalId: string): boolean {
  return approvalsDecidedByReaction.delete(approvalId);
}

/** A person a run's proposal was not approved for: the card expired or the approver rejected it. */
type DeclinedRecipient = { accountId: string; personE164: string };

// Process-global because the plugin loads in several module instances; a run's entry lives until
// the run ends.
const recipientsDeclinedInRun = resolveGlobalMap<string, DeclinedRecipient[]>(
  Symbol.for("openclaw.whatsapp-for-business.recipientsDeclinedInRun"),
);

/** Records that the card's run got no approval to write to the card's recipients. */
export function recordWhatsAppApprovalCardDeclined(card: WhatsAppApprovalCard): void {
  if (!card.sourceRunId) {
    return;
  }
  const declined = recipientsDeclinedInRun.get(card.sourceRunId) ?? [];
  for (const personE164 of card.recipients) {
    if (
      !declined.some(
        (known) => known.accountId === card.accountId && known.personE164 === personE164,
      )
    ) {
      declined.push({ accountId: card.accountId, personE164 });
    }
  }
  recipientsDeclinedInRun.set(card.sourceRunId, declined);
}

/** The people the run got no approval to write to. */
export function listWhatsAppRecipientsDeclinedInRun(runId: string): readonly DeclinedRecipient[] {
  return recipientsDeclinedInRun.get(runId) ?? [];
}

/** Forgets an ended run's declined recipients. */
export function forgetWhatsAppRecipientsDeclinedInRun(runId: string): void {
  recipientsDeclinedInRun.delete(runId);
}
