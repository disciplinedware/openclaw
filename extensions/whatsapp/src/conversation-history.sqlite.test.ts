import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntryAsync,
  recordSessionMetaFromInbound,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWhatsAppMessageCardsForTest,
  trackOpenWhatsAppMessageCard,
} from "./approval-stale-cards.js";
import { whatsappPlugin } from "./channel.js";
import { recordWhatsAppConversationMessage } from "./conversation-history.js";
import { setWhatsAppRuntime } from "./runtime.js";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolver.resolve,
}));
vi.mock("./send.js", () => ({
  sendMessageWhatsApp: transport.send,
  sendPollWhatsApp: vi.fn(),
  sendTypingWhatsApp: vi.fn(),
}));

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

describe("WhatsApp business messages in the guest transcript", () => {
  it("records phone-first messages once and keeps accounts and guests separate", async () => {
    await withOpenClawTestState({ prefix: "whatsapp-history-" }, async (state) => {
      const cfg = {
        session: {
          store: state.statePath("sessions.json"),
          dmScope: "per-account-channel-peer" as const,
        },
      };
      setRuntimeConfigSnapshot(cfg);
      setWhatsAppRuntime({
        channel: { session: { resolveStorePath, recordSessionMetaFromInbound } },
      } as unknown as PluginRuntime);
      const message = {
        cfg,
        accountId: "default",
        peer: "+447700900002",
        messageId: "phone-first",
        text: "You can arrive at noon.",
        timestampMs: Date.now(),
        author: "phone" as const,
      };
      await recordWhatsAppConversationMessage(message);
      await recordWhatsAppConversationMessage(message);
      await recordWhatsAppConversationMessage({
        ...message,
        peer: "+447700900003",
        text: "Other guest",
      });
      await recordWhatsAppConversationMessage({
        ...message,
        accountId: "other",
        text: "Other account",
      });
      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: message.accountId,
        peer: { kind: "direct", id: message.peer },
      });
      const storePath = resolveStorePath(cfg.session.store, { agentId: route.agentId });
      const session = await getSessionEntryAsync({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        storePath,
      });
      expect(session?.sessionId).toBeTruthy();
      const entries = await readVisibleSessionTranscriptMessageEntries({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionId: session!.sessionId!,
        storePath,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toMatchObject({
        role: "custom",
        customType: "whatsapp.history",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Business phone: You can arrive at noon."),
          },
        ],
      });
    });
  });

  it("a_card_enters_the_approvers_transcript_and_closes_no_card", async () => {
    await withOpenClawTestState({ prefix: "whatsapp-card-history-" }, async (state) => {
      const cfg = {
        session: {
          store: state.statePath("sessions.json"),
          dmScope: "per-account-channel-peer" as const,
        },
      };
      setRuntimeConfigSnapshot(cfg);
      setWhatsAppRuntime({
        channel: { session: { resolveStorePath, recordSessionMetaFromInbound } },
      } as unknown as PluginRuntime);
      const approver = "+447700900001";
      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: "default",
        peer: { kind: "direct", id: approver },
      });
      // A card the approver's own agent proposed stays open while its card is recorded.
      trackOpenWhatsAppMessageCard({
        request: { id: "plugin:open", request: { sessionKey: route.sessionKey } },
      } as Parameters<typeof trackOpenWhatsAppMessageCard>[0]);
      resolver.resolve.mockClear();
      await recordWhatsAppConversationMessage({
        cfg,
        accountId: "default",
        peer: approver,
        messageId: "card-1",
        text: "*+447700900002*\n> cuanto cuesta el taxi?\n\nConversation: agent:assistant:whatsapp:default:direct:+447700900002",
        timestampMs: Date.now(),
        author: "card",
      });
      expect(resolver.resolve).not.toHaveBeenCalled();
      clearWhatsAppMessageCardsForTest();
      const storePath = resolveStorePath(cfg.session.store, { agentId: route.agentId });
      const session = await getSessionEntryAsync({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        storePath,
      });
      const entries = await readVisibleSessionTranscriptMessageEntries({
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionId: session!.sessionId!,
        storePath,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.message).toMatchObject({
        role: "custom",
        customType: "whatsapp.approval-card",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Approval card: *+447700900002*"),
          },
        ],
      });
      expect(JSON.stringify(entries[0]?.message)).toContain(
        "Conversation: agent:assistant:whatsapp:default:direct:+447700900002",
      );
    });
  });

  it.each([
    {
      name: "host_agent_send_enters_the_guest_transcript_once",
      sender: "host",
      sends: 2,
      expected: 1,
      closes: true,
    },
    {
      name: "guest_agent_own_reply_is_not_copied",
      sender: "assistant",
      sends: 1,
      expected: 0,
      closes: false,
    },
    {
      name: "failed_send_is_not_recorded",
      sender: "host",
      sends: 1,
      expected: 0,
      fail: true,
      closes: false,
    },
  ])("$name", async ({ sender, sends, expected, fail, closes }) => {
    await withOpenClawTestState({ prefix: "whatsapp-sent-history-" }, async (state) => {
      const peer = "+447700900002";
      const store = state.statePath("{agentId}/sessions.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { assistant: {}, host: {} } },
        bindings: [{ agentId: "assistant", match: { channel: "whatsapp", accountId: "*" } }],
        channels: { whatsapp: { allowFrom: ["*"], dmPolicy: "open" } },
        session: { store, dmScope: "per-channel-peer" },
        commands: { ownerAllowFrom: ["whatsapp:+447700900001"] },
      };
      setRuntimeConfigSnapshot(cfg);
      setWhatsAppRuntime({
        logging: { shouldLogVerbose: () => false },
        channel: { session: { resolveStorePath, recordSessionMetaFromInbound } },
      } as unknown as PluginRuntime);
      const registry = createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      ]);
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      transport.send.mockImplementation(async (to: string, _text: string, options) => {
        if (fail) {
          throw new Error("Transport disconnected");
        }
        await options.onPlatformSendDispatch?.();
        return { messageId: "host-send", toJid: `${to.slice(1)}@s.whatsapp.net` };
      });
      const guestSession = `agent:assistant:whatsapp:direct:${peer}`;
      clearWhatsAppMessageCardsForTest();
      resolver.resolve.mockReset();
      // The guest agent's card still waits for the host when the business answers.
      trackOpenWhatsAppMessageCard({
        request: {
          id: "plugin:open",
          request: { toolName: "message", sessionKey: guestSession },
          createdAtMs: 0,
          expiresAtMs: 300_000,
        },
      } as never);
      const ctx = {
        channel: "whatsapp",
        action: "send",
        cfg,
        accountId: "default",
        sessionKey: sender === "host" ? `agent:host:whatsapp:direct:+447700900001` : guestSession,
        params: { to: peer, message: "Welcome from your host" },
        skipQueue: true,
        deliveryRetryOwner: "caller",
      } as unknown as ChannelMessageActionContext;
      for (let i = 0; i < sends; i++) {
        const sent = whatsappPlugin.actions!.handleAction!(ctx);
        if (fail) {
          await expect(sent).rejects.toThrow("Transport disconnected");
        } else {
          await sent;
        }
      }
      const storePath = resolveStorePath(store, { agentId: "assistant" });
      const session = await getSessionEntryAsync({
        agentId: "assistant",
        sessionKey: guestSession,
        storePath,
      });
      const entries = session?.sessionId
        ? await readVisibleSessionTranscriptMessageEntries({
            agentId: "assistant",
            sessionKey: guestSession,
            sessionId: session.sessionId,
            storePath,
          })
        : [];
      expect(entries).toHaveLength(expected);
      if (closes) {
        expect(resolver.resolve).toHaveBeenCalledWith(
          expect.objectContaining({ approvalId: "plugin:open", decision: "deny" }),
        );
      } else {
        expect(resolver.resolve).not.toHaveBeenCalled();
      }
      if (expected > 0) {
        expect(entries[0]?.message).toMatchObject({
          role: "custom",
          customType: "whatsapp.history",
          content: [
            {
              type: "text",
              text: expect.stringContaining("Business agent: Welcome from your host"),
            },
          ],
        });
      }
      resetGlobalHookRunner();
      resetPluginRuntimeStateForTest();
    });
  });
});
