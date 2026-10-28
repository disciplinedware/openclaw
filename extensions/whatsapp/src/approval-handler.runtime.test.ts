import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordWhatsAppApprovalReactionDecision } from "./approval-cards.js";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";
import { whatsappApprovalCapability } from "./approval-native.js";
import { createMemoryPluginStateRuntime } from "./plugin-state.test-helper.js";

const runtimeConfig = vi.hoisted(() => ({ current: {} as unknown }));
const recordHistory = vi.hoisted(() => vi.fn(async (_message: unknown) => {}));

vi.mock("./own-message-history.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./own-message-history.js")>()),

  recordWhatsAppAssistantMessageHistory: recordHistory,
}));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),

  getRuntimeConfig: () => runtimeConfig.current,
}));

beforeEach(() => {
  runtimeConfig.current = {};
  recordHistory.mockReset().mockResolvedValue(undefined);
});

describe("whatsappApprovalNativeRuntime", () => {
  it("renders allowed thumbs-only reactions in pending exec approvals", async () => {
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "exec-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "exec-1",
        commandText: "echo hi",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve exec-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve exec-1 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.reactionPayload.text).toContain("👍 Allow Once");
    expect(payload.reactionPayload.text).toContain("👎 Deny");
    expect(payload.reactionPayload.text).not.toContain("1️⃣ Allow Once");
    expect(payload.reactionPayload.text).not.toContain("2️⃣ Allow Always");
    expect(payload.reactionPayload.text).not.toContain("3️⃣ Deny");
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("renders a plugin approval as its approver reads it: the request, the reactions, the time left", async () => {
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc123",
        request: { title: "Approve message?", description: "Alex wrote:\n  > Hola" },
        createdAtMs: 0,
        expiresAtMs: 300_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc123",
        phase: "pending",
        title: "Approve message?",
        description: "Alex wrote:\n  > Hola",
        severity: "warning",
        pluginId: "acs",
        agentId: "assistant",
        metadata: [],
        expiresAtMs: 300_000,
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc123 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc123 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.reactionPayload.text).toBe(
      "Approve message?\n\nAlex wrote:\n  > Hola\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nYou have 5 minutes to answer.",
    );
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("localizes Guardian approval instructions and preserves the request text", async () => {
    runtimeConfig.current = {
      plugins: {
        entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } },
      },
    };
    const description = "Alex wrote:\n  > Hola";
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc123",
        request: { title: "Approve message?", description },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc123",
        phase: "pending",
        title: "Approve message?",
        description,
        severity: "warning",
        pluginId: "acs",
        agentId: "assistant",
        metadata: [],
        expiresAtMs: 60_000,
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc123 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc123 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.reactionPayload.text).toBe(
      `¿Enviar mensaje?\n\n${description}\n\n👍 Enviar · 👎 Rechazar · 1 min`,
    );
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("preserves an unknown plugin approval title and description in Spanish", async () => {
    runtimeConfig.current = {
      plugins: {
        entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } },
      },
    };
    const title = "Approve the account setting?";
    const description = "The plugin requests permission to change the setting.";
    const payload = await whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: { accountId: "default" },
      request: {
        id: "plugin:abc123",
        request: { title, description },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "plugin",
      nowMs: 0,
      view: {
        approvalKind: "plugin",
        approvalId: "plugin:abc123",
        phase: "pending",
        title,
        description,
        severity: "warning",
        pluginId: "example-plugin",
        agentId: "assistant",
        metadata: [],
        expiresAtMs: 60_000,
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve plugin:abc123 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve plugin:abc123 deny",
            style: "danger",
          },
        ],
      } as never,
    });

    expect(payload.reactionPayload.text).toBe(
      `${title}\n\n${description}\n\n👍 Aprobar una vez · 👎 Rechazar · 1 min`,
    );
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it.each([
    ["allow-once", true, "allow-once", "✅ Approved."],
    ["deny", true, "deny", "❌ Rejected."],
    ["deny", false, "cancelled", "🔄 Cancelled before a decision."],
  ] as const)(
    "tells how a plugin approval ended: %s, decided by a reaction %s",
    async (decision, byReaction, outcome, text) => {
      if (byReaction) {
        recordWhatsAppApprovalReactionDecision("plugin:abc123");
      }
      const result = await whatsappApprovalNativeRuntime.presentation.buildResolvedResult({
        request: { id: "plugin:abc123" },
        resolved: { id: "plugin:abc123", decision },
        view: { approvalKind: "plugin" },
      } as never);

      expect(result).toEqual({
        kind: "update",
        payload: { text, outcome, deliveryPending: decision !== "deny" },
      });
    },
  );

  it.each([
    ["allow-once", "✅ Aprobado."],
    ["allow-always", "✅ Aprobado; no volveré a preguntar."],
    ["deny", "❌ Rechazado."],
  ] as const)("localizes a plugin approval outcome: %s", async (decision, text) => {
    runtimeConfig.current = {
      plugins: {
        entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } },
      },
    };
    recordWhatsAppApprovalReactionDecision("plugin:abc123");
    const result = await whatsappApprovalNativeRuntime.presentation.buildResolvedResult({
      request: { id: "plugin:abc123" },
      resolved: { id: "plugin:abc123", decision },
      view: { approvalKind: "plugin" },
    } as never);

    expect(result).toEqual({
      kind: "update",
      payload: { text, outcome: decision, deliveryPending: decision !== "deny" },
    });
  });

  it("tells that a plugin approval expired", async () => {
    const result = await whatsappApprovalNativeRuntime.presentation.buildExpiredResult({
      request: { id: "plugin:abc123" },
      view: { approvalKind: "plugin" },
    } as never);

    expect(result).toEqual({
      kind: "update",
      payload: { outcome: "expired", text: "⏱️ Expired without an answer." },
    });
  });

  it.each(["approved", "denied", "expired"])(
    "keeps the proposal only when approved: %s",
    async (outcome) => {
      const description =
        "Jordan · +15550003333\nPedido: A-100\nRespuesta:\nHola 🌵\nSegunda línea";
      const params = {
        request: { id: "plugin:retained" },
        resolved: { id: "plugin:retained", decision: outcome === "denied" ? "deny" : "allow-once" },
        view: { approvalKind: "plugin", description },
      };
      const result =
        outcome === "expired"
          ? await whatsappApprovalNativeRuntime.presentation.buildExpiredResult(params as never)
          : await whatsappApprovalNativeRuntime.presentation.buildResolvedResult(params as never);
      expect(result).toMatchObject({ kind: "update" });
      if (outcome === "approved") {
        expect((result as { payload: { text: string } }).payload.text).toContain(description);
      } else {
        expect((result as { payload: { text: string } }).payload.text).not.toContain(description);
      }
      expect((result as { payload: { text: string } }).payload.text).not.toContain("React with");
    },
  );

  it("localizes an expired plugin approval", async () => {
    runtimeConfig.current = {
      plugins: {
        entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } },
      },
    };
    const result = await whatsappApprovalNativeRuntime.presentation.buildExpiredResult({
      request: { id: "plugin:abc123" },
      view: { approvalKind: "plugin" },
    } as never);

    expect(result).toEqual({
      kind: "update",
      payload: { outcome: "expired", text: "⏱️ Caducó sin respuesta." },
    });
  });

  it("normalizes WhatsApp targets and carries account ids into prepared delivery", async () => {
    await expect(
      whatsappApprovalNativeRuntime.transport.prepareTarget({
        cfg: {} as never,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: {
            to: "15551230000@s.whatsapp.net",
          },
        },
        request: {
          id: "exec-1",
          request: {
            command: "echo hi",
          },
          createdAtMs: 0,
          expiresAtMs: 60_000,
        },
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: "exec-1",
          commandText: "echo hi",
          actions: [],
        } as never,
        pendingPayload: {
          manualFallbackPayload: { text: "pending" },
          reactionPayload: {
            text: "pending",
            allowedDecisions: ["allow-once"],
            reactionBindings: [],
          },
        },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: {
        to: "+15551230000",
        accountId: "ops",
      },
    });
  });

  it("resolves the configured default account before binding native reactions", async () => {
    await expect(
      whatsappApprovalNativeRuntime.transport.prepareTarget({
        cfg: {
          channels: {
            whatsapp: {
              defaultAccount: "work",
              accounts: { work: {} },
            },
          },
        },
        plannedTarget: {
          surface: "origin",
          reason: "preferred",
          target: { to: "15551230000@s.whatsapp.net" },
        },
      } as never),
    ).resolves.toEqual({
      dedupeKey: expect.stringContaining("work:"),
      target: {
        to: "+15551230000",
        accountId: "work",
      },
    });
  });
});

it("waits for native reaction binding and cleanup completion", async () => {
  const bindingWrite = createDeferred<null>();
  const cleanupWrite = createDeferred<void>();
  const register = vi
    .spyOn(await import("./approval-reactions.js"), "registerWhatsAppApprovalReactionTarget")
    .mockReturnValue(bindingWrite.promise);
  const unregister = vi
    .spyOn(await import("./approval-reactions.js"), "unregisterWhatsAppApprovalReactionTarget")
    .mockReturnValue(cleanupWrite.promise);
  const entry = {
    accountId: "default",
    to: "+15551230000",
    remoteJid: "15551230000@s.whatsapp.net",
    messageId: "approval-message",
    text: "Approve message?",
  };
  const request = {
    id: "exec-pending",
    request: { command: "echo hi" },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  };
  try {
    let bindingSettled = false;
    const binding = Promise.resolve(
      whatsappApprovalNativeRuntime.interactions!.bindPending!({
        cfg: {},
        accountId: "default",
        entry,
        request,
        approvalKind: "exec",
        view: {
          approvalKind: "exec",
          approvalId: request.id,
          phase: "pending",
          title: "Approval",
          metadata: [],
          commandText: "echo hi",
          actions: [],
          expiresAtMs: 60_000,
        },
        pendingPayload: {
          manualFallbackPayload: { text: "pending" },
          reactionPayload: {
            text: "pending",
            allowedDecisions: ["allow-once"],
            reactionBindings: [],
          },
        },
      }),
    ).then((value) => {
      bindingSettled = true;
      return value;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(bindingSettled).toBe(false);
    bindingWrite.resolve(null);
    await expect(binding).resolves.toBeNull();

    let cleanupSettled = false;
    const cleanup = Promise.resolve(
      whatsappApprovalNativeRuntime.interactions!.unbindPending!({
        cfg: {},
        accountId: "default",
        entry,
        request,
        approvalKind: "exec",
        binding: true,
      }),
    ).then(() => {
      cleanupSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(cleanupSettled).toBe(false);
    cleanupWrite.resolve();
    await cleanup;
  } finally {
    bindingWrite.resolve(null);
    cleanupWrite.resolve();
    register.mockRestore();
    unregister.mockRestore();
  }
});

describe("whatsappApprovalNativeRuntime delivery", () => {
  it.each([false, true])(
    "unbinds the old prompt before updating and binds a fresh replacement, edit failure %s",
    async (fails) => {
      const runtime = await import("./runtime.js");
      const reactions = await import("./approval-reactions.js");
      const state = createMemoryPluginStateRuntime();
      vi.spyOn(runtime, "getWhatsAppRuntime").mockReturnValue(state.runtime as never);
      vi.spyOn(runtime, "getOptionalWhatsAppRuntime").mockReturnValue(state.runtime as never);
      reactions.clearWhatsAppApprovalReactionTargetsForTest();
      const send = await import("./send.js");
      const remoteJid = "15550000200@s.whatsapp.net";
      let serial = 0;
      vi.spyOn(send, "sendMessageWhatsApp").mockImplementation(
        async () => ({ messageId: `prompt-${++serial}`, toJid: remoteJid }) as never,
      );
      vi.spyOn(send, "sendTypingWhatsApp").mockResolvedValue(undefined);
      const target = (messageId: string) =>
        reactions.resolveWhatsAppApprovalReactionTargetWithPersistence({
          accountId: "default",
          remoteJid,
          messageId,
          reactionKey: "👍",
        });
      const remove = vi
        .spyOn(send, "editMessageWhatsApp")
        .mockImplementation(async (_chat, messageId) => {
          expect(await target(messageId)).toBeNull();
          if (fails) {
            throw new Error("edit unavailable");
          }
        });
      const cfg = {
        commands: { ownerAllowFrom: ["whatsapp:+15550000200"] },
        channels: { whatsapp: {} },
      };
      const handler = await createChannelApprovalHandlerFromCapability({
        capability: whatsappApprovalCapability,
        cfg,
        accountId: "default",
        context: { accountId: "default" },
        channel: "whatsapp",
        channelLabel: "WhatsApp",
        label: "test/whatsapp",
        clientDisplayName: "WhatsApp test",
      });
      const request = (id: string) => ({
        id,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: {
          title: "Approve message?",
          description: "Reply",
          allowedDecisions: ["allow-once", "deny"] as const,
          turnSourceChannel: "whatsapp",
          turnSourceTo: "+15550000300",
          turnSourceAccountId: "default",
        },
      });
      try {
        expect(handler).not.toBeNull();
        await handler!.handleRequested(request("plugin:old"));
        expect(await target("prompt-1")).toMatchObject({ approvalId: "plugin:old" });
        await handler!.handleResolved({ id: "plugin:old", decision: "deny", ts: Date.now() });
        expect(remove).toHaveBeenCalledOnce();
        expect(await target("prompt-1")).toBeNull();
        await handler!.handleRequested(request("plugin:new"));
        expect(await target(`prompt-${fails ? 3 : 2}`)).toMatchObject({ approvalId: "plugin:new" });
        expect(await target("prompt-1")).toBeNull();
      } finally {
        await handler?.stop();
        reactions.clearWhatsAppApprovalReactionTargetsForTest();
        vi.restoreAllMocks();
      }
    },
  );

  it.each([false, true])(
    "retains a completed proposal and reports its outcome, with edit failure %s",
    async (fails) => {
      const send = await import("./send.js");
      const remove = vi.spyOn(send, "editMessageWhatsApp");
      if (fails) {
        remove.mockRejectedValue(new Error("edit unavailable"));
      } else {
        remove.mockResolvedValue(undefined);
      }
      const notify = vi
        .spyOn(send, "sendMessageWhatsApp")
        .mockResolvedValue({ messageId: "status-1", toJid: "15550000200@s.whatsapp.net" });
      const runtime = await import("./runtime.js");
      vi.spyOn(runtime, "getWhatsAppRuntime").mockReturnValue({
        logging: { shouldLogVerbose: () => false },
      } as never);
      const entry = {
        accountId: "default",
        to: "+15550000200",
        remoteJid: "15550000200@s.whatsapp.net",
        messageId: "old",
        text: "Old proposal",
      };
      try {
        await whatsappApprovalNativeRuntime.transport.updateEntry!({
          cfg: {},
          entry,
          payload: { text: "✅ Approved." },
        } as never);
        expect(remove).toHaveBeenCalledExactlyOnceWith(entry.remoteJid, "old", "✅ Approved.", {
          cfg: {},
          accountId: "default",
        });
        expect(notify).toHaveBeenCalledTimes(fails ? 1 : 0);
        if (fails) {
          expect(notify).toHaveBeenCalledWith(
            entry.to,
            "✅ Approved.",
            expect.objectContaining({ quotedMessageKey: expect.objectContaining({ id: "old" }) }),
          );
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("quotes the retained prompt when editing is unavailable", async () => {
    const send = await import("./send.js");
    vi.spyOn(send, "editMessageWhatsApp").mockRejectedValue(new Error("edit unavailable"));
    const sendMessage = vi
      .spyOn(send, "sendMessageWhatsApp")
      .mockResolvedValue({ messageId: "prompt-1", toJid: "15550000200@s.whatsapp.net" } as never);
    vi.spyOn(send, "sendTypingWhatsApp").mockResolvedValue(undefined as never);
    const runtime = await import("./runtime.js");
    vi.spyOn(runtime, "getWhatsAppRuntime").mockReturnValue({
      logging: { shouldLogVerbose: () => false },
    } as never);
    const { transport } = whatsappApprovalNativeRuntime;

    const entry = await transport.deliverPending({
      cfg: {} as never,
      preparedTarget: { to: "+15550000200", accountId: "default" },
      pendingPayload: { reactionPayload: { text: "Approve message?", allowedDecisions: [] } },
      request: {
        id: "plugin:source",
        request: { sessionKey: "agent:main:whatsapp:default:direct:+15550000300" },
      },
    } as never);
    await transport.updateEntry?.({
      cfg: {} as never,
      entry,
      payload: { text: "✅ Approved." },
    } as never);

    expect(sendMessage).toHaveBeenLastCalledWith(
      "+15550000200",
      "✅ Approved.",
      expect.objectContaining({
        quotedMessageKey: expect.objectContaining({
          id: "prompt-1",
          messageText: "Approve message?",
        }),
      }),
    );
    expect(recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "whatsapp_system",
        peerE164: "+15550000200",
        messageId: "prompt-1",
        text: "Approve message?\n\n[Source conversation: agent:main:whatsapp:default:direct:+15550000300]",
      }),
    );
    expect(sendMessage.mock.calls[0]?.[1]).toBe("Approve message?");
    vi.restoreAllMocks();
  });
});

describe("whatsappApprovalNativeRuntime message cards", () => {
  it("shows the guest's messages, replaces a cancelled card and reminds once on expiry", async () => {
    const runtime = await import("./runtime.js");
    const state = createMemoryPluginStateRuntime();
    vi.spyOn(runtime, "getWhatsAppRuntime").mockReturnValue(state.runtime as never);
    vi.spyOn(runtime, "getOptionalWhatsAppRuntime").mockReturnValue(state.runtime as never);
    const { recordWhatsAppUnansweredMessage } = await import("./overdue-answers.js");
    const send = await import("./send.js");
    const remoteJid = "79262070342@s.whatsapp.net";
    let serial = 0;
    const sendMessage = vi
      .spyOn(send, "sendMessageWhatsApp")
      .mockImplementation(
        async () => ({ messageId: `card-${++serial}`, toJid: remoteJid }) as never,
      );
    vi.spyOn(send, "sendTypingWhatsApp").mockResolvedValue(undefined as never);
    const edit = vi.spyOn(send, "editMessageWhatsApp").mockResolvedValue(undefined);
    const guest = "+5219902410673";
    const minute = (value: number) => Date.UTC(2026, 9, 20, 21, value);
    // The card shows a message's date only when it is not today's.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(minute(20));
    await recordWhatsAppUnansweredMessage(
      { accountId: "default", personE164: guest },
      {
        id: "m1",
        sentAtMs: minute(15),
        receivedAtMs: minute(15),
        text: "Когда заселение?",
        senderName: "Lika",
      },
    );
    const cfg = { agents: { defaults: { userTimezone: "America/Cancun" } } };
    const { transport } = whatsappApprovalNativeRuntime;
    const deliver = async (id: string) =>
      await transport.deliverPending({
        cfg: cfg as never,
        preparedTarget: { to: "+79262070342", accountId: "default" },
        pendingPayload: { reactionPayload: { text: "Approve message?", allowedDecisions: [] } },
        request: {
          id,
          request: {
            title: "Approve message?",
            description: "💬 Заселение с 15:00.",
            sessionKey: "agent:assistant:whatsapp:default:direct:+5219902410673",
            runId: `run-${id}`,
            scope: {
              kind: "message-send",
              target: "whatsapp",
              recipientCount: 1,
              recipients: [guest],
            },
          },
        },
      } as never);
    const { listWhatsAppRecipientsDeclinedInRun, readWhatsAppCancelledProposals } =
      await import("./approval-cards.js");
    const guestSession = "agent:assistant:whatsapp:default:direct:+5219902410673";
    try {
      const first = await deliver("plugin:first");
      expect(sendMessage.mock.calls[0]?.[1]).toBe(
        "📥 Lika · +5219902410673\n16:15 Когда заселение?\n\nApprove message?",
      );
      // The guest's next message cancels the run; its turn starts before the cancellation lands.
      await expect(readWhatsAppCancelledProposals(guestSession, Date.now())).resolves.toEqual([
        expect.objectContaining({ recipients: [guest], description: "💬 Заселение с 15:00." }),
      ]);

      await transport.updateEntry!({
        cfg: cfg as never,
        entry: first,
        payload: { outcome: "cancelled", text: "🔄 Cancelled before a decision." },
      } as never);
      const second = await deliver("plugin:second");
      expect(edit).toHaveBeenLastCalledWith(remoteJid, "card-1", "🔄 Updated below.", {
        cfg,
        accountId: "default",
      });
      await expect(readWhatsAppCancelledProposals(guestSession, Date.now())).resolves.toEqual([
        expect.objectContaining({ description: "💬 Заселение с 15:00." }),
      ]);

      const sentBefore = sendMessage.mock.calls.length;
      await transport.updateEntry!({
        cfg: cfg as never,
        entry: second,
        payload: { outcome: "expired", text: "⏱️ Expired without an answer." },
      } as never);
      expect(sendMessage).toHaveBeenCalledTimes(sentBefore + 1);
      // The expired card's run may not propose to the guest again; the cancelled one's could.
      expect(listWhatsAppRecipientsDeclinedInRun("run-plugin:second")).toEqual([
        { accountId: "default", personE164: guest },
      ]);
      expect(listWhatsAppRecipientsDeclinedInRun("run-plugin:first")).toEqual([]);
      expect(sendMessage).toHaveBeenLastCalledWith(
        "+79262070342",
        "⏳ Lika has been waiting for an answer since 16:15.",
        expect.objectContaining({ quotedMessageKey: expect.objectContaining({ id: "card-2" }) }),
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
