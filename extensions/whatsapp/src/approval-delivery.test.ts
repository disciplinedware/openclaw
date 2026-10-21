import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainWhatsAppApprovalDeliveries,
  registerWhatsAppApprovalDelivery,
} from "./approval-delivery.js";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { createMemoryPluginStateRuntime } from "./plugin-state.test-helper.js";

const history = vi.hoisted(() => vi.fn());
const configuration = vi.hoisted(() => ({ current: {} }));
vi.mock("./own-message-history.js", () => ({ recordWhatsAppAssistantMessageHistory: history }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => configuration.current,
}));
vi.mock("./active-listener.js", () => ({ getActiveWebListener: () => undefined }));

beforeEach(() => {
  vi.restoreAllMocks();
  history.mockReset().mockResolvedValue(undefined);
  configuration.current = {
    session: { dmScope: "per-account-channel-peer" },
    channels: { whatsapp: {} },
  };
});

async function fixture() {
  const state = createMemoryPluginStateRuntime();
  vi.spyOn(await import("./runtime.js"), "getWhatsAppRuntime").mockReturnValue(
    state.runtime as never,
  );
  const send = await import("./send.js");
  const sent = vi
    .spyOn(send, "sendMessageWhatsApp")
    .mockImplementation(async () => ({ messageId: "card-1", toJid: "15550000200@s.whatsapp.net" }));
  vi.spyOn(send, "sendTypingWhatsApp").mockResolvedValue(undefined);
  const edited = vi.spyOn(send, "editMessageWhatsApp").mockResolvedValue(undefined);
  type Hook = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>;
  const callbacks = new Map<string, Hook>();
  const logger = { warn: vi.fn(), error: vi.fn() };
  registerWhatsAppApprovalDelivery({
    on: (name: string, callback: Hook) => callbacks.set(name, callback),
    logger,
  } as never);
  const sessionKey = "agent:main:whatsapp:default:direct:+15550000300";
  const request = {
    id: "plugin:proposal",
    request: {
      title: "Approve message?",
      description: "Reply exactly",
      toolName: "message",
      runId: "run-1",
      toolCallId: "call-1",
      sessionKey,
      scope: {
        kind: "message-send",
        target: "whatsapp",
        recipientCount: 1,
        recipients: ["+15550000300"],
      },
    },
  };
  const entry = await whatsappApprovalNativeRuntime.transport.deliverPending({
    cfg: configuration.current,
    preparedTarget: { to: "+15550000200", accountId: "default" },
    request,
    pendingPayload: {
      reactionPayload: { text: "Reply exactly", allowedDecisions: ["allow-once", "deny"] },
    },
  } as never);
  const settle = (details: unknown, overrides: Record<string, unknown> = {}) =>
    callbacks.get("after_tool_call")!(
      {
        toolName: "message",
        runId: "run-1",
        toolCallId: "call-1",
        params: { action: "send", message: "Reply exactly" },
        result: { details },
        ...overrides,
      },
      { sessionKey, runId: "run-1", toolCallId: "call-1" },
    );
  const resolve = async (decision: "allow-once" | "deny") => {
    const result = await whatsappApprovalNativeRuntime.presentation.buildResolvedResult({
      request,
      resolved: { decision },
      view: { approvalKind: "plugin", description: "Reply exactly" },
    } as never);
    if (result.kind !== "update") {
      throw new Error("missing update");
    }
    await whatsappApprovalNativeRuntime.transport.updateEntry!({
      cfg: configuration.current,
      entry,
      payload: result.payload,
    } as never);
  };
  return { sent, edited, settle, resolve, callbacks, logger, state };
}

describe("WhatsApp approved delivery receipts", () => {
  const sentDetails = {
    channel: "whatsapp",
    to: "+15550000300",
    deliveryStatus: "sent",
    result: { messageId: "contact-message" },
  };

  it.each(["approval-first", "delivery-first"])(
    "keeps exact text and an independent sent receipt with %s",
    async (order) => {
      const f = await fixture();
      expect(f.sent).toHaveBeenCalledTimes(1);
      if (order === "approval-first") {
        await f.resolve("allow-once");
      }
      await f.settle(sentDetails);
      if (order === "delivery-first") {
        await f.resolve("allow-once");
      }
      expect(f.sent).toHaveBeenCalledTimes(2);
      expect(f.sent).toHaveBeenLastCalledWith(
        "+15550000200",
        "✅ Approved. 📤 Sent.",
        expect.objectContaining({
          accountId: "default",
          quotedMessageKey: expect.objectContaining({ id: "card-1", messageText: "Reply exactly" }),
        }),
      );
      expect(f.edited).toHaveBeenCalledExactlyOnceWith(
        "15550000200@s.whatsapp.net",
        "card-1",
        "✅ Approved.\n\nReply exactly",
        expect.anything(),
      );
      expect(history).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("📤 Sent.") }),
      );
      await f.settle(sentDetails);
      expect(f.sent).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [{ deliveryStatus: "failed" }, {}, "❌ Not sent."],
    [{ deliveryStatus: "partial_failed" }, {}, "⚠️ Delivery could not be confirmed."],
    [undefined, { error: "connection lost" }, "⚠️ Delivery could not be confirmed."],
    [
      { channel: "whatsapp", to: "+15550000300", result: {} },
      {},
      "⚠️ Delivery could not be confirmed.",
    ],
  ])(
    "reports actual failure or uncertainty without retrying the contact",
    async (details, overrides, expected) => {
      const f = await fixture();
      await f.resolve("allow-once");
      await f.settle(details, overrides);
      expect(f.sent).toHaveBeenCalledTimes(2);
      expect(f.sent.mock.calls[1]?.[0]).toBe("+15550000200");
      expect(f.sent.mock.calls[1]?.[1]).toContain(expected);
    },
  );

  it("ignores another run, session and tool call, then records only the exact operation", async () => {
    const f = await fixture();
    await f.settle(sentDetails, { runId: "other-run" });
    await f.settle(sentDetails, { toolCallId: "other-call" });
    await f.callbacks.get("after_tool_call")!(
      { toolName: "message", runId: "run-1", toolCallId: "call-1" },
      { sessionKey: "other-session" },
    );
    expect(f.sent).toHaveBeenCalledTimes(1);
    await f.settle(sentDetails);
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  it("does not report delivery for a denied proposal", async () => {
    const f = await fixture();
    await f.resolve("deny");
    await f.settle(sentDetails);
    expect(f.sent).toHaveBeenCalledTimes(1);
  });

  it("keeps original and recipient session references in history only", async () => {
    const f = await fixture();
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "[Recipient conversation: agent:main:whatsapp:default:direct:+15550000300]",
        ),
      }),
    );
    expect(f.sent.mock.calls[0]?.[1]).toBe("Reply exactly");
  });

  it("does not repeat a contact send after a receipt transport failure", async () => {
    const f = await fixture();
    f.sent.mockRejectedValueOnce(new Error("receipt failed"));
    await f.settle(sentDetails);
    await f.settle(sentDetails);
    expect(f.sent).toHaveBeenCalledTimes(2);
    expect(f.logger.error).toHaveBeenCalledWith(expect.stringContaining("receipt failed"));
    const store = f.state.runtime.state.openKeyedStore<{ processIdentity: string }>({
      namespace: "whatsapp.approval-delivery",
      retention: "retained",
    });
    expect(await store.entries()).toHaveLength(2);
    for (const { key, value } of await store.entries()) {
      await store.register(key, { ...value, processIdentity: "previous-process" });
    }
    await drainWhatsAppApprovalDeliveries("other-account", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(2);
    await drainWhatsAppApprovalDeliveries("default", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(3);
    expect(f.sent.mock.calls[2]?.[0]).toBe("+15550000200");
    expect(f.sent.mock.calls[2]?.[1]).toBe("✅ Approved. 📤 Sent.");
    expect(await store.entries()).toEqual([]);
    await drainWhatsAppApprovalDeliveries("default", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(3);
  });

  it("claims simultaneous duplicate result events only once", async () => {
    const f = await fixture();
    await Promise.all([f.settle(sentDetails), f.settle(sentDetails)]);
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  const fromPreviousProcess = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const store = f.state.runtime.state.openKeyedStore<{ processIdentity: string }>({
      namespace: "whatsapp.approval-delivery",
      retention: "retained",
    });
    for (const { key, value } of await store.entries()) {
      await store.register(key, { ...value, processIdentity: "previous-process" });
    }
    return store;
  };

  it("reports an approved card of an interrupted process as unknown without repeating contact actions", async () => {
    const f = await fixture();
    await f.resolve("allow-once");
    const store = await fromPreviousProcess(f);
    await drainWhatsAppApprovalDeliveries("default", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(2);
    expect(f.sent.mock.calls[1]?.[1]).toContain("Delivery could not be confirmed");
    expect(f.sent.mock.calls[1]?.[1]).not.toContain("Approved");
    expect(await store.entries()).toEqual([]);
  });

  it("marks a card of an interrupted process that nobody decided as cancelled, sending nothing", async () => {
    const f = await fixture();
    const store = await fromPreviousProcess(f);
    await drainWhatsAppApprovalDeliveries("default", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.edited).toHaveBeenCalledExactlyOnceWith(
      "15550000200@s.whatsapp.net",
      "card-1",
      "🔄 Cancelled before a decision.",
      expect.anything(),
    );
    expect(await store.entries()).toEqual([]);
  });

  it("leaves the cards of the running process to their own flow", async () => {
    const f = await fixture();
    await drainWhatsAppApprovalDeliveries("default", f.logger);
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.edited).not.toHaveBeenCalled();
  });
});
