import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";

const transcript = vi.hoisted(() => ({ entries: [] as unknown[] }));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntryAsync: async () => ({ sessionId: "session-1" }),
  loadTranscriptEventsSync: () => transcript.entries,
}));

const pendingMessageCard = () =>
  whatsappApprovalNativeRuntime.presentation.buildPendingPayload({
    cfg: {} as never,
    accountId: "default",
    context: { accountId: "default" },
    request: {
      id: "plugin:approval-1",
      createdAtMs: 0,
      expiresAtMs: 60_000,
      request: {
        title: "message",
        description: "Pide revisión.",
        toolName: "message",
        toolCallId: "call-pending",
        sessionKey: "agent:assistant:whatsapp:direct:+15550000300",
        agentId: "assistant",
        allowedDecisions: ["allow-once", "deny"],
      },
    },
    approvalKind: "plugin",
    nowMs: 0,
    view: {
      approvalKind: "plugin",
      approvalId: "plugin:approval-1",
      actions: [
        {
          decision: "allow-once",
          label: "Allow Once",
          command: "/approve plugin:approval-1 allow-once",
          style: "success",
        },
        {
          decision: "deny",
          label: "Deny",
          command: "/approve plugin:approval-1 deny",
          style: "danger",
        },
      ],
    } as never,
  });

beforeEach(() => {
  transcript.entries = [];
});

describe("WhatsApp message approval card", () => {
  it("shows the proposed message and offers 👍 and 👎", async () => {
    transcript.entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-pending",
              name: "message",
              arguments: { message: "Hola" },
            },
          ],
        },
      },
    ];
    const payload = await pendingMessageCard();

    expect(payload.reactionPayload.text).toContain("Send message?");
    expect(payload.reactionPayload.text).toContain("Hola");
    expect(payload.reactionPayload.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("offers only 👎 when the transcript does not hold the proposed message", async () => {
    const payload = await pendingMessageCard();

    expect(payload.reactionPayload.allowedDecisions).toEqual(["deny"]);
    expect(payload.reactionPayload.text).not.toContain("👍");
  });
});

describe("WhatsApp message approval outcome", () => {
  const request = {
    id: "plugin:approval-1",
    createdAtMs: 0,
    expiresAtMs: 60_000,
    request: { title: "message", description: "", toolName: "message" },
  };
  const cfg = {
    plugins: { entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } } },
  } as never;

  it("answers the card in its language when the host decides or the card expires", async () => {
    const resolved = await whatsappApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg,
      accountId: "default",
      context: { accountId: "default" },
      request,
      resolved: { id: request.id, decision: "deny" },
      view: { approvalKind: "plugin" },
      entry: {},
    } as never);
    const expired = await whatsappApprovalNativeRuntime.presentation.buildExpiredResult({
      cfg,
      accountId: "default",
      context: { accountId: "default" },
      request,
      view: { approvalKind: "plugin" },
      entry: {},
    } as never);

    expect(resolved).toEqual({
      kind: "update",
      payload: { text: "❌ Rechazado.", cardOutcome: "❌ Rechazado." },
    });
    expect(expired).toEqual({
      kind: "update",
      payload: { text: "⏱️ Caducó sin respuesta.", cardOutcome: "⏱️ Caducó sin respuesta." },
    });
  });
});
