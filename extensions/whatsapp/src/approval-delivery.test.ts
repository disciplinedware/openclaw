import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteWhatsAppApprovalAllowSubmitted,
  registerWhatsAppApprovalDelivery,
  WHATSAPP_UNAPPROVED_SEND_RESULT_TEXT,
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

type PersistHook = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => { message?: { role: string; content: unknown } } | undefined;

const interruptedResult = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "message",
  content: [{ type: "text", text: "Tool call interrupted before a result was recorded" }],
  isError: true,
  timestamp: 1,
};

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
  const persist = (overrides: Record<string, unknown> = {}, context = { sessionKey }) =>
    (callbacks.get("tool_result_persist") as unknown as PersistHook)(
      {
        toolName: "message",
        toolCallId: "call-1",
        isSynthetic: true,
        message: interruptedResult,
        ...overrides,
      },
      context,
    );
  return { sent, edited, settle, resolve, persist, callbacks, logger, state };
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
    await f.callbacks.get("gateway_start")!({}, {});
    expect(f.sent).toHaveBeenCalledTimes(3);
    expect(f.sent.mock.calls[2]?.[0]).toBe("+15550000200");
    expect(f.sent.mock.calls[2]?.[1]).toBe("✅ Approved. 📤 Sent.");
    expect(await store.entries()).toEqual([]);
    await f.callbacks.get("gateway_start")!({}, {});
    expect(f.sent).toHaveBeenCalledTimes(3);
  });

  it("claims simultaneous duplicate result events only once", async () => {
    const f = await fixture();
    await Promise.all([f.settle(sentDetails), f.settle(sentDetails)]);
    expect(f.sent).toHaveBeenCalledTimes(2);
  });

  it("reports an interrupted process as unknown without claiming approval or repeating contact actions", async () => {
    const f = await fixture();
    const store = f.state.runtime.state.openKeyedStore<{ processIdentity: string }>({
      namespace: "whatsapp.approval-delivery",
      retention: "retained",
    });
    for (const { key, value } of await store.entries()) {
      await store.register(key, { ...value, processIdentity: "previous-process" });
    }
    await f.callbacks.get("gateway_start")!({}, {});
    expect(f.sent).toHaveBeenCalledTimes(2);
    expect(f.sent.mock.calls[1]?.[1]).toContain("Delivery could not be confirmed");
    expect(f.sent.mock.calls[1]?.[1]).not.toContain("Approved");
    expect(await store.entries()).toEqual([]);
  });
});

describe("WhatsApp sends interrupted while their card waits", () => {
  const notSent = [{ type: "text", text: WHATSAPP_UNAPPROVED_SEND_RESULT_TEXT }];

  it("records a send nobody approved as not sent", async () => {
    const f = await fixture();
    expect(f.persist()?.message).toEqual({ ...interruptedResult, content: notSent });
  });

  it.each([
    [
      "a WhatsApp reaction allow",
      () => noteWhatsAppApprovalAllowSubmitted({ accountId: "default", messageId: "card-1" }),
    ],
    ["an allow decision from another route", undefined],
  ])("keeps the core's unknown outcome after %s", async (_name, allow) => {
    const f = await fixture();
    if (allow) {
      allow();
    } else {
      await f.resolve("allow-once");
    }
    expect(f.persist()).toBeUndefined();
  });

  it("keeps a recorded result and forgets the send", async () => {
    const f = await fixture();
    expect(f.persist({ isSynthetic: false })).toBeUndefined();
    expect(f.persist()).toBeUndefined();
  });

  it("ignores another session and tool call", async () => {
    const f = await fixture();
    expect(f.persist({ toolCallId: "other-call" })).toBeUndefined();
    expect(f.persist({}, { sessionKey: "other-session" })).toBeUndefined();
    expect(f.persist()?.message?.content).toEqual(notSent);
  });
});
