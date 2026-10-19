import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  formatWhatsAppOwnMessageContent,
  WHATSAPP_OWN_MESSAGE_SENDER_LABEL,
  type WhatsAppOwnMessage,
} from "./own-messages.js";
import { createPerRuntimeStoreOpener } from "./plugin-keyed-store.js";
import { getWhatsAppRuntime } from "./runtime.js";

const OWN_MESSAGE_HISTORY_NAMESPACE = "whatsapp.own-message-history";
const LEGACY_OWN_MESSAGE_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

type WhatsAppOwnMessageAuthor = "phone" | "assistant";
type WhatsAppAssistantHistorySource = "message_tool" | "whatsapp_system";

type StoredWhatsAppOwnMessage = Pick<
  WhatsAppOwnMessage,
  "messageId" | "peerE164" | "timestampMs" | "text" | "mediaKind"
> & { author: WhatsAppOwnMessageAuthor; source?: WhatsAppAssistantHistorySource };

type OwnMessageHistoryStore = {
  register(key: string, value: StoredWhatsAppOwnMessage): Promise<void>;
  registerIfAbsent(key: string, value: StoredWhatsAppOwnMessage): Promise<boolean>;
  lookup(key: string): Promise<StoredWhatsAppOwnMessage | undefined>;
  entries(): Promise<Array<{ key: string; value: StoredWhatsAppOwnMessage }>>;
  delete(key: string): Promise<boolean>;
};

const openStoreForRuntime = createPerRuntimeStoreOpener((runtime): OwnMessageHistoryStore =>
  runtime.state.openKeyedStore<StoredWhatsAppOwnMessage>({
    namespace: OWN_MESSAGE_HISTORY_NAMESPACE,
    retention: "retained",
  }),
);

const openLegacyStoreForRuntime = createPerRuntimeStoreOpener((runtime): OwnMessageHistoryStore =>
  runtime.state.openKeyedStore<StoredWhatsAppOwnMessage>({
    namespace: OWN_MESSAGE_HISTORY_NAMESPACE,
    maxEntries: 1000,
    defaultTtlMs: LEGACY_OWN_MESSAGE_HISTORY_TTL_MS,
  }),
);

const migrations = new WeakMap<object, Promise<OwnMessageHistoryStore>>();

async function openOwnMessageHistoryStore(): Promise<OwnMessageHistoryStore> {
  const runtime = getWhatsAppRuntime();
  const migration = migrations.get(runtime);
  if (migration) {
    return migration;
  }
  const pending = migrateLegacyOutbox(runtime);
  migrations.set(runtime, pending);
  try {
    return await pending;
  } catch (error) {
    migrations.delete(runtime);
    throw error;
  }
}

async function migrateLegacyOutbox(
  runtime: ReturnType<typeof getWhatsAppRuntime>,
): Promise<OwnMessageHistoryStore> {
  const legacy = openLegacyStoreForRuntime(runtime);
  const retained = openStoreForRuntime(runtime);
  const entries = await legacy.entries();
  for (const entry of entries) {
    await retained.registerIfAbsent(entry.key, entry.value);
    const copied = await retained.lookup(entry.key);
    if (JSON.stringify(copied) !== JSON.stringify(entry.value)) {
      throw new Error(`WhatsApp history outbox migration conflicts on key ${entry.key}`);
    }
  }
  return retained;
}

function buildOwnMessageKey(params: {
  accountId: string;
  peerE164: string;
  messageId: string;
}): string {
  return JSON.stringify([params.accountId, params.peerE164, params.messageId]);
}

function readOwnMessageKey(key: string): {
  accountId: string;
  peerE164: string;
  messageId: string;
} {
  const value: unknown = JSON.parse(key);
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((part) => typeof part !== "string" || part.trim() === "")
  ) {
    throw new Error("WhatsApp own-message history contains an invalid key");
  }
  return { accountId: value[0], peerE164: value[1], messageId: value[2] };
}

function messageText(message: StoredWhatsAppOwnMessage): string {
  const content = formatWhatsAppOwnMessageContent(message);
  const authorLabel =
    message.author === "phone"
      ? "[sent manually from the linked WhatsApp phone]"
      : message.source === "whatsapp_system"
        ? "[WhatsApp approval or status]"
        : "[sent by the assistant from another chat]";
  return `${WHATSAPP_OWN_MESSAGE_SENDER_LABEL}: ${authorLabel}${content ? ` ${content}` : ""}`;
}

function resolveSessionMetadataContext(params: { accountId: string; peerE164: string }) {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    ChatType: "direct",
    AccountId: params.accountId,
    From: `whatsapp:${params.peerE164}`,
    OriginatingChannel: "whatsapp",
    OriginatingTo: `whatsapp:${params.peerE164}`,
  };
}

async function appendStoredMessage(
  message: StoredWhatsAppOwnMessage,
  identity: { accountId: string; peerE164: string; messageId: string },
): Promise<void> {
  const cfg = getRuntimeConfig();
  const route = resolveAgentRoute({
    cfg,
    channel: "whatsapp",
    accountId: identity.accountId,
    peer: { kind: "direct", id: identity.peerE164 },
  });
  const runtime = getWhatsAppRuntime();
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const entry = await runtime.channel.session.recordSessionMetaFromInbound({
    storePath,
    sessionKey: route.sessionKey,
    ctx: resolveSessionMetadataContext(identity),
    createIfMissing: true,
  });
  if (!entry?.sessionId) {
    throw new Error(`WhatsApp conversation session was not registered for ${route.sessionKey}`);
  }

  const idempotencyKey = `whatsapp:${JSON.stringify([
    identity.accountId,
    identity.peerE164,
    identity.messageId,
  ])}`;
  const result = await appendSessionTranscriptMessageByIdentityStrict({
    agentId: route.agentId,
    config: cfg,
    eventId: idempotencyKey,
    idempotencyLookup: "scan",
    message: {
      role: "assistant",
      content: [{ type: "text", text: messageText(message) }],
      timestamp: message.timestampMs,
      idempotencyKey,
    },
    now: message.timestampMs,
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
}

async function drainEntries(
  entries: Array<{ key: string; value: StoredWhatsAppOwnMessage }>,
): Promise<void> {
  const store = await openOwnMessageHistoryStore();
  const legacy = openLegacyStoreForRuntime(getWhatsAppRuntime());
  const failures: unknown[] = [];
  for (const entry of entries.toSorted(
    (left, right) => left.value.timestampMs - right.value.timestampMs,
  )) {
    try {
      const identity = readOwnMessageKey(entry.key);
      await appendStoredMessage(entry.value, identity);
      await store.delete(entry.key);
      await legacy.delete(entry.key);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to append ${failures.length} WhatsApp history record(s)`,
    );
  }
}

async function registerAndAppend(
  identity: { accountId: string; peerE164: string; messageId: string },
  message: StoredWhatsAppOwnMessage,
): Promise<void> {
  const key = buildOwnMessageKey(identity);
  const store = await openOwnMessageHistoryStore();
  await store.register(key, message);
  const value = await store.lookup(key);
  const entry = value ? { key, value } : undefined;
  if (!entry) {
    throw new Error("WhatsApp own-message outbox did not retain the registered record");
  }
  await drainEntries([entry]);
}

/** Persists a linked-phone message before appending it to the peer transcript. */
export async function recordWhatsAppOwnMessageHistory(message: WhatsAppOwnMessage): Promise<void> {
  await registerAndAppend(message, {
    messageId: message.messageId,
    peerE164: message.peerE164,
    timestampMs: message.timestampMs,
    text: message.text,
    ...(message.mediaKind ? { mediaKind: message.mediaKind } : {}),
    author: "phone",
  });
}

/** Persists a delivered assistant or system message before appending it to the peer transcript. */
export async function recordWhatsAppAssistantMessageHistory(
  message: Pick<
    WhatsAppOwnMessage,
    "accountId" | "peerE164" | "messageId" | "timestampMs" | "text"
  > & {
    source?: WhatsAppAssistantHistorySource;
  },
): Promise<void> {
  await registerAndAppend(message, {
    messageId: message.messageId,
    peerE164: message.peerE164,
    timestampMs: message.timestampMs,
    text: message.text,
    author: "assistant",
    ...(message.source ? { source: message.source } : {}),
  });
}

/** Migrates and retries pending records without starting an agent turn. */
async function drainWhatsAppOwnMessageHistory(): Promise<void> {
  const store = await openOwnMessageHistoryStore();
  await drainEntries(await store.entries());
}

export function registerWhatsAppOwnMessageHistory(api: OpenClawPluginApi): void {
  api.on("gateway_start", async () => {
    try {
      await drainWhatsAppOwnMessageHistory();
    } catch (error) {
      api.logger.warn(`WhatsApp history outbox drain failed: ${String(error)}`);
    }
  });
}
