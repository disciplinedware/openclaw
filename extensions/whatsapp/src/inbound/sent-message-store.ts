import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "../plugin-id.js";
import { createPerRuntimeStoreOpener } from "../plugin-keyed-store.js";
import { getOptionalWhatsAppRuntime } from "../runtime.js";
import { buildMessageKey } from "./dedupe.js";

const SENT_MESSAGE_NAMESPACE = "whatsapp.sent-messages";
/** Bounds the store; at most this many sends within the TTL are remembered. */
const SENT_MESSAGE_MAX_ENTRIES = 5000;
/** How long a message this plugin sent is still recognized as its own echo. */
const SENT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/** The part of the host's keyed plugin-state store that this module uses. */
type SentMessageStore = {
  register(key: string, value: true): Promise<void>;
  lookup(key: string): Promise<true | undefined>;
};

const openStoreForRuntime = createPerRuntimeStoreOpener((runtime): SentMessageStore =>
  runtime.state.openKeyedStore<true>({
    namespace: SENT_MESSAGE_NAMESPACE,
    maxEntries: SENT_MESSAGE_MAX_ENTRIES,
    defaultTtlMs: SENT_MESSAGE_TTL_MS,
  }),
);

function openSentMessageStore(): SentMessageStore | undefined {
  const runtime = getOptionalWhatsAppRuntime();
  return runtime ? openStoreForRuntime(runtime) : undefined;
}

function reportSentMessageStoreError(error: unknown): void {
  try {
    getOptionalWhatsAppRuntime()
      ?.logging.getChildLogger({
        plugin: WHATSAPP_FOR_BUSINESS_PLUGIN_ID,
        feature: "sent-message-state",
      })
      .warn("WhatsApp sent-message state failed", { error: String(error) });
  } catch {
    // Best effort only.
  }
}

/**
 * Persists the id of a message this plugin sent, so its echo is never taken for a message
 * typed on the phone, also after a restart. The in-memory echo cache covers the write window.
 */
export function rememberWhatsAppSentMessage(params: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): void {
  const key = buildMessageKey(params);
  const store = key ? openSentMessageStore() : undefined;
  if (!key || !store) {
    return;
  }
  void store.register(key, true).catch(reportSentMessageStoreError);
}

export async function isWhatsAppSentMessage(params: {
  accountId: string;
  remoteJid: string;
  alternateRemoteJid?: string | null;
  messageId: string;
}): Promise<boolean> {
  const store = openSentMessageStore();
  if (!store) {
    return false;
  }
  const keys = [params.remoteJid, params.alternateRemoteJid]
    .filter((jid): jid is string => Boolean(jid))
    .map((remoteJid) => buildMessageKey({ ...params, remoteJid }))
    .filter((key): key is string => key !== null);
  for (const key of keys) {
    if ((await store.lookup(key)) !== undefined) {
      return true;
    }
  }
  return false;
}
