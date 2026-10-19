import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it } from "vitest";
import { setWhatsAppRuntime } from "../runtime-setter-api.js";
import {
  registerWhatsAppOwnMessageHistory,
  recordWhatsAppOwnMessageHistory,
} from "./own-message-history.js";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";

const namespace = "whatsapp.own-message-history";
const oldTtlMs = 24 * 60 * 60 * 1000;
type LegacyStoredMessage = {
  messageId: string;
  peerE164: string;
  timestampMs: number;
  text: string;
  author: "phone";
};

async function runGatewayStart(): Promise<void> {
  let handler: (() => Promise<void>) | undefined;
  registerWhatsAppOwnMessageHistory({
    on: (_name: string, callback: () => Promise<void>) => {
      handler = callback;
    },
  } as unknown as OpenClawPluginApi);
  if (!handler) {
    throw new Error("WhatsApp history gateway_start handler was not registered");
  }
  await handler();
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("WhatsApp own message transcript history", () => {
  it("migrates a bounded legacy row, writes idempotently, and exposes history without an agent turn", async () => {
    await withOpenClawTestState({ prefix: "whatsapp-history-transcript-" }, async (state) => {
      const cfg = {
        session: {
          store: state.statePath("sessions.json"),
          dmScope: "per-account-channel-peer" as const,
        },
        channels: { whatsapp: {} },
      };
      setRuntimeConfigSnapshot(cfg);
      openOpenClawStateDatabase({ env: state.env });
      const accountId = "default";
      const peerE164 = "+15550000300";
      const legacyMessage: LegacyStoredMessage = {
        messageId: "manual-message-legacy",
        peerE164,
        timestampMs: 1_759_999_999_000,
        text: "Old manual reply",
        author: "phone",
      };
      const legacyKey = JSON.stringify([accountId, peerE164, legacyMessage.messageId]);
      const legacyStore = createPluginStateKeyedStoreForTests<LegacyStoredMessage>(
        WHATSAPP_FOR_BUSINESS_PLUGIN_ID,
        { namespace, maxEntries: 1000, defaultTtlMs: oldTtlMs, env: state.env },
      );
      await legacyStore.register(legacyKey, legacyMessage);

      const openKeyedStore = <T>(
        options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0],
      ) =>
        createPluginStateKeyedStoreForTests<T>(WHATSAPP_FOR_BUSINESS_PLUGIN_ID, {
          ...options,
          env: state.env,
        });
      setWhatsAppRuntime({
        state: { openKeyedStore },
        channel: {
          session: {
            resolveStorePath,
            recordSessionMetaFromInbound,
          },
        },
      } as unknown as PluginRuntime);

      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId,
        peer: { kind: "direct", id: peerE164 },
      });
      const storePath = resolveStorePath(cfg.session.store, { agentId: route.agentId });

      await runGatewayStart();
      expect(await legacyStore.lookup(legacyKey)).toBeUndefined();

      const message = {
        accountId,
        messageId: "manual-message-1",
        chatJid: "15550000300@s.whatsapp.net",
        peerE164,
        timestampMs: 1_760_000_000_000,
        text: "  The report is ready on Mondays.  ",
      };
      await recordWhatsAppOwnMessageHistory(message);
      await recordWhatsAppOwnMessageHistory(message);

      const session = await recordSessionMetaFromInbound({
        storePath,
        sessionKey: route.sessionKey,
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
          AccountId: accountId,
          From: `whatsapp:${peerE164}`,
          OriginatingChannel: "whatsapp",
          OriginatingTo: `whatsapp:${peerE164}`,
        },
        createIfMissing: false,
      });
      expect(session?.sessionId).toBeTruthy();
      const entries = await readVisibleSessionTranscriptMessageEntries({
        agentId: route.agentId,
        sessionId: session!.sessionId!,
        sessionKey: route.sessionKey,
        storePath,
      });
      expect(entries).toHaveLength(2);
      expect(entries.map(({ message: row }) => row)).toMatchObject([
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "(self): [sent manually from the linked WhatsApp phone] Old manual reply",
            },
          ],
          timestamp: legacyMessage.timestampMs,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "(self): [sent manually from the linked WhatsApp phone]   The report is ready on Mondays.  ",
            },
          ],
          timestamp: message.timestampMs,
        },
      ]);

      const contactTurn = await appendSessionTranscriptMessageByIdentityStrict({
        agentId: route.agentId,
        config: cfg,
        eventId: "contact-message-1",
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: "When is the report ready?",
          timestamp: message.timestampMs + 1,
        },
        now: message.timestampMs + 1,
        sessionId: session!.sessionId!,
        sessionKey: route.sessionKey,
        storePath,
        updateMode: "none",
      });
      expect(contactTurn.kind).toBe("result");
      const afterTurn = await readVisibleSessionTranscriptMessageEntries({
        agentId: route.agentId,
        sessionId: session!.sessionId!,
        sessionKey: route.sessionKey,
        storePath,
      });
      const afterTurnContent = afterTurn.map(({ message: row }) => {
        if (row.role !== "assistant" && row.role !== "user") {
          throw new Error(`Unexpected transcript role: ${row.role}`);
        }
        return row.content;
      });
      expect(afterTurnContent).toEqual([
        [
          {
            type: "text",
            text: "(self): [sent manually from the linked WhatsApp phone] Old manual reply",
          },
        ],
        [
          {
            type: "text",
            text: "(self): [sent manually from the linked WhatsApp phone]   The report is ready on Mondays.  ",
          },
        ],
        "When is the report ready?",
      ]);
    });
  });
});
