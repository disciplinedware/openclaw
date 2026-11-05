// Whatsapp tests cover approval handler plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";

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
    messageIds: ["approval-message"],
    lastPartText: "pending",
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

it("binds every part of a card that arrives in several messages", async () => {
  vi.spyOn(await import("./runtime.js"), "getWhatsAppRuntime").mockReturnValue({
    logging: { shouldLogVerbose: () => false },
  } as never);
  vi.spyOn(await import("./send.js"), "sendMessageWhatsApp").mockImplementation(
    async (_to, _body, options) => {
      for (const messageId of ["part-1", "part-2", "part-3"]) {
        await options.onDeliveryResult?.({
          messageId,
          toJid: "15551230000@s.whatsapp.net",
          text: `${messageId} text`,
        });
      }
      return { messageId: "part-1", toJid: "15551230000@s.whatsapp.net" };
    },
  );
  vi.spyOn(await import("./send.js"), "sendTypingWhatsApp").mockResolvedValue(undefined);
  const register = vi
    .spyOn(await import("./approval-reactions.js"), "registerWhatsAppApprovalReactionTarget")
    .mockResolvedValue({ approvalId: "plugin:1", approvalKind: "plugin", allowedDecisions: [] });
  try {
    const entry = await whatsappApprovalNativeRuntime.transport.deliverPending({
      cfg: {},
      preparedTarget: { to: "+15551230000", accountId: "default" },
      pendingPayload: {
        manualFallbackPayload: { text: "card" },
        reactionPayload: {
          text: "card",
          allowedDecisions: ["allow-once", "deny"],
          reactionBindings: [],
        },
      },
    } as never);
    expect(entry?.messageIds).toEqual(["part-1", "part-2", "part-3"]);
    expect(entry?.lastPartText).toBe("part-3 text");

    await whatsappApprovalNativeRuntime.interactions!.bindPending!({
      entry,
      request: { id: "plugin:1", request: {} },
      view: { approvalKind: "plugin", expiresAtMs: Date.now() + 60_000 },
      pendingPayload: { reactionPayload: { allowedDecisions: ["allow-once", "deny"] } },
    } as never);
    expect(register.mock.calls.map(([target]) => target.messageId)).toEqual([
      "part-1",
      "part-2",
      "part-3",
    ]);
  } finally {
    vi.restoreAllMocks();
  }
});

describe("message card outcome in place", () => {
  const remoteJid = "15551230000@s.whatsapp.net";

  async function deliver(parts: Array<{ messageId: string; text: string }>, footer: string) {
    vi.spyOn(await import("./runtime.js"), "getWhatsAppRuntime").mockReturnValue({
      logging: { shouldLogVerbose: () => false },
    } as never);
    vi.spyOn(await import("./send.js"), "sendTypingWhatsApp").mockResolvedValue(undefined);
    const send = vi
      .spyOn(await import("./send.js"), "sendMessageWhatsApp")
      .mockImplementation(async (_to, _body, options) => {
        if (parts.length > 1) {
          for (const part of parts) {
            await options.onDeliveryResult?.({ ...part, toJid: remoteJid });
          }
        }
        return { messageId: parts[0]!.messageId, toJid: remoteJid };
      });
    const entry = await whatsappApprovalNativeRuntime.transport.deliverPending({
      cfg: {},
      preparedTarget: { to: "+15551230000", accountId: "default" },
      pendingPayload: {
        manualFallbackPayload: { text: "card" },
        reactionPayload: {
          text: parts.map((part) => part.text).join(""),
          allowedDecisions: ["allow-once", "deny"],
          reactionBindings: [],
        },
        footer,
      },
    } as never);
    send.mockClear();
    return { entry: entry!, send };
  }

  it.each([
    {
      name: "one_part",
      parts: [
        {
          messageId: "card-1",
          text: "¿Enviar mensaje?\n\nHola\n\n👍 Enviar · 👎 Rechazar · 5 min",
        },
      ],
      edited: ["card-1", "¿Enviar mensaje?\n\nHola\n\n✅ Aprobado."],
    },
    {
      name: "last_of_three_parts",
      parts: [
        { messageId: "part-1", text: "first" },
        { messageId: "part-2", text: "second" },
        { messageId: "part-3", text: "tail\n\n👍 Enviar · 👎 Rechazar · 5 min" },
      ],
      edited: ["part-3", "tail\n\n✅ Aprobado."],
    },
  ])("replaces_the_footer_with_the_outcome_$name", async ({ parts, edited }) => {
    try {
      const { entry, send } = await deliver(parts, "👍 Enviar · 👎 Rechazar · 5 min");
      const edit = vi
        .spyOn(await import("./send.js"), "editMessageWhatsApp")
        .mockResolvedValue(undefined);
      await whatsappApprovalNativeRuntime.transport.updateEntry!({
        cfg: {},
        entry,
        payload: { text: "✅ Aprobado.", cardOutcome: "✅ Aprobado." },
      } as never);
      expect(edit).toHaveBeenCalledWith(remoteJid, edited[0], edited[1], {
        cfg: {},
        accountId: "default",
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("replies_with_the_outcome_when_the_edit_fails", async () => {
    try {
      const { entry, send } = await deliver(
        [{ messageId: "card-1", text: "Hola\n\n👍 Enviar · 👎 Rechazar · 5 min" }],
        "👍 Enviar · 👎 Rechazar · 5 min",
      );
      vi.spyOn(await import("./send.js"), "editMessageWhatsApp").mockRejectedValue(
        new Error("edit window closed"),
      );
      await whatsappApprovalNativeRuntime.transport.updateEntry!({
        cfg: {},
        entry,
        payload: { text: "⏱️ Caducó sin respuesta.", cardOutcome: "⏱️ Caducó sin respuesta." },
      } as never);
      expect(send).toHaveBeenCalledWith(
        "+15551230000",
        "⏱️ Caducó sin respuesta.",
        expect.objectContaining({
          quotedMessageKey: { id: "card-1", remoteJid, fromMe: true },
        }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("replies_for_an_approval_that_is_no_message_card", async () => {
    try {
      const { entry, send } = await deliver([{ messageId: "exec-1", text: "Run it?" }], "");
      const edit = vi.spyOn(await import("./send.js"), "editMessageWhatsApp");
      await whatsappApprovalNativeRuntime.transport.updateEntry!({
        cfg: {},
        entry,
        payload: { text: "Approved." },
      } as never);
      expect(edit).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("+15551230000", "Approved.", expect.anything());
    } finally {
      vi.restoreAllMocks();
    }
  });
});
