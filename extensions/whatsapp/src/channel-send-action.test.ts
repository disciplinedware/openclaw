import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  addTestHook,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("./send.js", () => ({
  sendMessageWhatsApp: transport.send,
  sendPollWhatsApp: vi.fn(),
  sendTypingWhatsApp: vi.fn(),
}));
vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({ logging: { shouldLogVerbose: () => false } }),
  getOptionalWhatsAppRuntime: () => undefined,
}));

const hostSession = "agent:host:whatsapp:default:direct:+447700900001";
const guestSession = "agent:assistant:whatsapp:default:direct:+447700900002";
const cfg: OpenClawConfig = {
  agents: { entries: { host: {}, assistant: {} } },
  bindings: [{ agentId: "assistant", match: { channel: "whatsapp", accountId: "*" } }],
  channels: { whatsapp: { allowFrom: ["*"], dmPolicy: "open" as const } },
};

function context(
  overrides: Partial<ChannelMessageActionContext> = {},
): ChannelMessageActionContext {
  return {
    channel: "whatsapp",
    action: "send",
    cfg,
    accountId: "default",
    sessionKey: hostSession,
    params: { to: "+447700900002", message: "Check-in is at noon." },
    skipQueue: true,
    deliveryRetryOwner: "caller",
    ...overrides,
  };
}

async function send(ctx = context()) {
  if (!whatsappPlugin.actions?.handleAction) {
    throw new Error("WhatsApp action handler missing");
  }
  return whatsappPlugin.actions.handleAction(ctx);
}

describe("WhatsApp channel-owned sends", () => {
  let registry: ReturnType<typeof createTestRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport.send.mockImplementation(async (to, _text, options) => {
      await options.onPlatformSendDispatch?.();
      return { messageId: "sent-1", toJid: `${to.slice(1)}@s.whatsapp.net` };
    });
    registry = createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
    ]);
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  it("routes_send_through_the_gateway_channel_action", () => {
    expect(whatsappPlugin.actions?.describeMessageTool({ cfg })?.actions).toContain("send");
    expect(whatsappPlugin.actions?.supportsAction?.({ action: "send" })).toBe(true);
    expect(whatsappPlugin.actions?.resolveExecutionMode?.({ action: "send" })).toBe("gateway");
  });

  it.each([false, true])(
    "preserves_host_identity_when_guest_admitted_%s",
    async (guestAdmitted) => {
      const admitted = new Set([hostSession, ...(guestAdmitted ? [guestSession] : [])]);
      const observed: string[] = [];
      addTestHook({
        registry,
        pluginId: "policy",
        hookName: "message_sending",
        handler: (_event: unknown, ctx: { sessionKey?: string }) => {
          observed.push(ctx.sessionKey ?? "");
          return { cancel: !admitted.has(ctx.sessionKey ?? "") };
        },
      });
      const result = await send(
        context({
          params: {
            to: "+447700900002",
            message: "Check-in is at noon.",
            sessionKey: guestSession,
            __sessionKey: guestSession,
          },
        }),
      );
      expect(observed).toEqual([hostSession]);
      expect(transport.send).toHaveBeenCalledTimes(1);
      expect(result?.details).toMatchObject({ ok: true, messageId: "sent-1" });
    },
  );

  it("keeps_concurrent_identical_messages_bound_to_their_sources", async () => {
    const observed: string[] = [];
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "message_sending",
      handler: async (_event: unknown, ctx: { sessionKey?: string }) => {
        await Promise.resolve();
        observed.push(ctx.sessionKey ?? "");
      },
    });
    await Promise.all([send(), send(context({ sessionKey: guestSession }))]);
    expect(observed.toSorted()).toEqual([hostSession, guestSession].toSorted());
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it("returns_policy_suppression_without_transport_delivery", async () => {
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "message_sending",
      handler: () => ({ cancel: true }),
    });
    expect((await send())?.details).toMatchObject({
      status: "suppressed",
      reason: "cancelled_by_message_sending_hook",
    });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("delivers_the_text_changed_by_the_policy", async () => {
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "message_sending",
      handler: () => ({ content: "Approved text." }),
    });
    await send();
    expect(transport.send).toHaveBeenCalledWith(
      "+447700900002",
      "Approved text.",
      expect.anything(),
    );
  });

  it("stops_after_authority_expires_during_preparation", async () => {
    let active = true;
    addTestHook({
      registry,
      pluginId: "policy",
      hookName: "message_sending",
      handler: async () => {
        await Promise.resolve();
        active = false;
      },
    });
    await expect(
      send(
        context({
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("Run cancelled");
            }
          },
        }),
      ),
    ).rejects.toThrow("Run cancelled");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("preserves_media_and_reports_partial_delivery_without_losing_receipts", async () => {
    transport.send
      .mockResolvedValueOnce({ messageId: "media-1", toJid: "447700900002@s.whatsapp.net" })
      .mockRejectedValueOnce(new Error("Transport disconnected"));
    const result = send(
      context({
        params: {
          to: "+447700900002",
          message: "Photos",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          asDocument: true,
        },
      }),
    );
    await expect(result).rejects.toMatchObject({
      message: "Transport disconnected",
      sentBeforeError: true,
      deliveryResult: { visibleReplySent: true, messageIds: ["media-1"] },
    });
    expect(transport.send).toHaveBeenNthCalledWith(
      1,
      "+447700900002",
      "Photos",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        forceDocument: true,
      }),
    );
  });

  it("reports_transport_failure_without_success", async () => {
    transport.send.mockRejectedValueOnce(new Error("Transport disconnected"));
    await expect(send()).rejects.toThrow("Transport disconnected");
  });

  it.each([true, false])("enforces_target_allowlist_for_direct_actions_%s", async (allowed) => {
    const request = send(
      context({
        cfg: {
          ...cfg,
          channels: { whatsapp: { allowFrom: [allowed ? "+447700900002" : "+447700900003"] } },
        },
      }),
    );
    if (allowed) {
      expect((await request)?.details).toMatchObject({ ok: true });
      expect(transport.send).toHaveBeenCalledTimes(1);
    } else {
      await expect(request).rejects.toThrow("not in the configured allowFrom list");
      expect(transport.send).not.toHaveBeenCalled();
    }
  });
});
