import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../../../extensions/whatsapp/channel-plugin-api.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  addTestHook,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugin-sdk/channel-test-helpers.js";
import { sendHandlers } from "./send.js";
import { createMessageMethodTestDriver, makeContext } from "./send.test-support.js";

const transport = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../../extensions/whatsapp/src/send.js", () => ({
  sendMessageWhatsApp: transport.send,
  sendPollWhatsApp: vi.fn(),
  sendTypingWhatsApp: vi.fn(),
}));
vi.mock("../../../extensions/whatsapp/src/runtime.js", () => ({
  getWhatsAppRuntime: () => ({ logging: { shouldLogVerbose: () => false } }),
  getOptionalWhatsAppRuntime: () => undefined,
}));

const hostSession = "agent:host:whatsapp:default:direct:+447700900001";
const guestSession = "agent:assistant:whatsapp:default:direct:+447700900002";
const cfg = {
  agents: { list: [{ id: "host" }, { id: "assistant", default: true }] },
  channels: { whatsapp: { allowFrom: ["*"], dmPolicy: "open" as const } },
};
const { runMessageActionRequest } = createMessageMethodTestDriver(() => sendHandlers);

describe("WhatsApp Gateway delivery source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transport.send.mockImplementation(async (_to, _text, options) => {
      await options.onPlatformSendDispatch?.();
      return { messageId: "gateway-send-1", toJid: "447700900002@s.whatsapp.net" };
    });
    setRuntimeConfigSnapshot(cfg);
  });
  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
  });

  it.each([false, true])(
    "passes_trusted_host_context_and_honors_policy_denial_%s",
    async (deny) => {
      const registry = createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      ]);
      const sourceKeys: Array<string | undefined> = [];
      addTestHook({
        registry,
        pluginId: "policy",
        hookName: "message_sending",
        handler: (_event, ctx) => {
          sourceKeys.push(ctx.sessionKey);
          return { cancel: deny };
        },
      });
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      const gatewayContext = makeContext();
      gatewayContext.getRuntimeConfig = () => cfg;
      const request = {
        channel: "whatsapp",
        action: "send",
        accountId: "default",
        sessionKey: hostSession,
        agentId: "host",
        idempotencyKey: `wa-send-${deny}`,
        params: {
          to: "+447700900002",
          message: "Check-in is at noon.",
          sessionKey: guestSession,
          __sessionKey: guestSession,
        },
      };
      const { respond } = await runMessageActionRequest(request, undefined, gatewayContext);
      expect(respond.mock.calls[0]).toEqual(expect.arrayContaining([true]));
      expect(sourceKeys).toEqual([hostSession]);
      expect(transport.send).toHaveBeenCalledTimes(deny ? 0 : 1);
      await runMessageActionRequest(request, undefined, gatewayContext);
      expect(transport.send).toHaveBeenCalledTimes(deny ? 0 : 1);
    },
  );
});
