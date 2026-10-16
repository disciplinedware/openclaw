import type { WhatsAppOwnMessage } from "./own-messages.js";
import { createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getWhatsAppRuntime } from "./runtime.js";

const OWN_MESSAGE_HISTORY_NAMESPACE = "whatsapp.own-message-history";
/** Bounds the store across all chats; the oldest entries go first. */
const OWN_MESSAGE_HISTORY_MAX_ENTRIES = 1000;
/** An own message not consumed by a later turn of its chat within this time is dropped. */
const OWN_MESSAGE_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Who sent a message of the account: the person on the linked phone, or the assistant from a
 * session other than this chat's (an agent `message` send to this chat).
 */
type WhatsAppOwnMessageAuthor = "phone" | "assistant";

export type StoredWhatsAppOwnMessage = Pick<
  WhatsAppOwnMessage,
  "messageId" | "peerE164" | "timestampMs" | "text" | "mediaKind"
> & { author: WhatsAppOwnMessageAuthor };

/** The part of the host's keyed plugin-state store that this module uses. */
type OwnMessageHistoryStore = {
  register(key: string, value: StoredWhatsAppOwnMessage): Promise<void>;
  entries(): Promise<Array<{ key: string; value: StoredWhatsAppOwnMessage }>>;
  delete(key: string): Promise<boolean>;
};

const openStoreForRuntime = createPerRuntimeStoreOpener((runtime): OwnMessageHistoryStore =>
  runtime.state.openKeyedStore<StoredWhatsAppOwnMessage>({
    namespace: OWN_MESSAGE_HISTORY_NAMESPACE,
    maxEntries: OWN_MESSAGE_HISTORY_MAX_ENTRIES,
    defaultTtlMs: OWN_MESSAGE_HISTORY_TTL_MS,
  }),
);

function openOwnMessageHistoryStore(): OwnMessageHistoryStore {
  return openStoreForRuntime(getWhatsAppRuntime());
}

// Keys are JSON arrays, so one chat's prefix cannot match another account or number.
function buildOwnMessageKey(params: {
  accountId: string;
  peerE164: string;
  messageId: string;
}): string {
  return JSON.stringify([params.accountId, params.peerE164, params.messageId]);
}

function chatKeyPrefix(params: { accountId: string; peerE164: string }): string {
  return `${JSON.stringify([params.accountId, params.peerE164]).slice(0, -1)},`;
}

/** Keeps the message until the next turn of its chat consumes it. */
export async function recordWhatsAppOwnMessageHistory(message: WhatsAppOwnMessage): Promise<void> {
  const entry: StoredWhatsAppOwnMessage = {
    messageId: message.messageId,
    peerE164: message.peerE164,
    timestampMs: message.timestampMs,
    text: message.text,
    ...(message.mediaKind ? { mediaKind: message.mediaKind } : {}),
    author: "phone",
  };
  await openOwnMessageHistoryStore().register(buildOwnMessageKey(message), entry);
}

/** Keeps an assistant's message, sent to this chat from another session, for the chat's next turn. */
export async function recordWhatsAppAssistantMessageHistory(
  message: Pick<
    WhatsAppOwnMessage,
    "accountId" | "peerE164" | "messageId" | "timestampMs" | "text"
  >,
): Promise<void> {
  const entry: StoredWhatsAppOwnMessage = {
    messageId: message.messageId,
    peerE164: message.peerE164,
    timestampMs: message.timestampMs,
    text: message.text,
    author: "assistant",
  };
  await openOwnMessageHistoryStore().register(buildOwnMessageKey(message), entry);
}

/** All pending own messages of one direct chat, oldest first, with their keys. */
export async function listWhatsAppOwnMessageHistory(params: {
  accountId: string;
  peerE164: string;
}): Promise<Array<{ key: string; message: StoredWhatsAppOwnMessage }>> {
  const prefix = chatKeyPrefix(params);
  const entries = await openOwnMessageHistoryStore().entries();
  return entries
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => ({ key: entry.key, message: entry.value }))
    .toSorted((left, right) => left.message.timestampMs - right.message.timestampMs);
}

/** Drops own messages a dispatched turn has carried into its session or passed over. */
export async function deleteWhatsAppOwnMessageHistory(keys: readonly string[]): Promise<void> {
  const store = openOwnMessageHistoryStore();
  await Promise.all(keys.map((key) => store.delete(key)));
}
