import type { PluginApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWhatsAppMessageCard, isWhatsAppMessageApproval } from "./approval-card.js";
import { acceptsWhatsAppPluginConfig, whatsappPluginEntries } from "./plugin-config.test-helper.js";

const store = vi.hoisted(() => ({
  sessions: new Map<string, string>(),
  entries: new Map<string, unknown[]>(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) => {
    const sessionId = store.sessions.get(sessionKey);
    return sessionId ? { sessionId } : undefined;
  },
  // A linear transcript: each event's parent is the one before it, unless the event names one.
  loadTranscriptEventsSync: ({ sessionId }: { sessionId: string }) =>
    [{ type: "session" }, ...(store.entries.get(sessionId) ?? [])].map((event, index) =>
      Object.assign({ id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}` }, event),
    ),
}));

const GUEST = "+15550000300";
const SESSION_KEY = `agent:assistant:whatsapp:direct:${GUEST}`;

const user = (text: string, timestamp: string) => ({
  type: "message",
  timestamp,
  message: { role: "user", content: text },
});
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
const result = (toolCallId: string, text: string, isError = false) => ({
  type: "message",
  message: { role: "toolResult", toolCallId, isError, content: [{ type: "text", text }] },
});

function request(overrides: Partial<PluginApprovalRequest["request"]> = {}): PluginApprovalRequest {
  return {
    id: "plugin:approval-1",
    createdAtMs: 0,
    expiresAtMs: 5 * 60_000,
    request: {
      title: "message",
      description: "El asistente pide revisión.",
      toolName: "message",
      toolCallId: "call-pending",
      sessionKey: SESSION_KEY,
      agentId: "assistant",
      turnSourceChannel: "whatsapp",
      turnSourceTo: GUEST,
      ...overrides,
    },
  };
}

const cfg = (config: Record<string, unknown> = {}) =>
  ({
    agents: {
      defaults: { userTimezone: "UTC" },
      list: [{ id: "assistant", default: true }, { id: "host" }],
    },
    session: { dmScope: "per-channel-peer" },
    plugins: whatsappPluginEntries(config),
  }) as OpenClawConfig;

async function card(config?: Record<string, unknown>, req = request()) {
  return (await cardWithFooter(config, req))?.text;
}

async function cardWithFooter(config?: Record<string, unknown>, req = request()) {
  return await buildWhatsAppMessageCard({
    cfg: cfg(config),
    request: req,
    allowedDecisions: ["allow-once", "deny"],
    nowMs: 0,
  });
}

beforeEach(() => {
  store.sessions = new Map([[SESSION_KEY, "session-1"]]);
  store.entries = new Map([
    [
      "session-1",
      [
        user("Hola", "2026-11-04T10:00:00.000Z"),
        call("call-earlier", "message", { action: "send", message: "¡Hola! ¿En qué le ayudo?" }),
        result("call-earlier", '{"status":"ok"}'),
        user("¿Cuánto cuesta una noche más?", "2026-11-04T10:05:00.000Z"),
        call("call-failed", "message", { action: "send", message: "Le confirmo pronto." }),
        result("call-failed", '{"status":"error","error":"Approval timed out"}'),
        user("¿Hay respuesta?", "2026-11-04T10:12:00.000Z"),
        call("call-lookup", "pms__find", { guest_phone: GUEST }),
        result("call-lookup", "{}"),
        call("call-pending", "message", {
          action: "send",
          message: "Una noche más cuesta 3200 MXN.",
          requestApproval: true,
          media: "https://example.com/rate.pdf",
        }),
      ],
    ],
  ]);
});

describe("WhatsApp message card", () => {
  it("accepts limits from one to ten through the plugin manifest", () => {
    for (const limit of [1, 10]) {
      expect(acceptsWhatsAppPluginConfig({ approvalUnansweredMessageLimit: limit })).toBe(true);
    }
    for (const limit of [0, 11, 1.5]) {
      expect(acceptsWhatsAppPluginConfig({ approvalUnansweredMessageLimit: limit })).toBe(false);
    }
  });

  it("uses sent time when phone and guest history arrive late", async () => {
    store.entries.set("session-1", [
      user("New question", "2026-11-04T10:20:00.000Z"),
      {
        type: "message",
        message: {
          role: "custom",
          customType: "whatsapp.history",
          timestamp: Date.parse("2026-11-04T10:10:00.000Z"),
          content: "Business phone: Earlier answer",
        },
      },
      {
        type: "message",
        message: {
          role: "custom",
          customType: "whatsapp.inbound-history",
          timestamp: Date.parse("2026-11-04T10:00:00.000Z"),
          content: "Old answered question",
        },
      },
      {
        type: "message",
        message: {
          role: "custom",
          customType: "whatsapp.inbound-history",
          timestamp: Date.parse("2026-11-04T10:15:00.000Z"),
          content: "Earlier unanswered question",
        },
      },
      call("call-pending", "message", { target: GUEST, message: "Answer" }),
    ]);
    const text = await card();
    expect(text).not.toContain("Old answered question");
    expect(text).toContain("10:15 Earlier unanswered question\n10:20 New question");
  });
  it("shows at most ten unanswered messages by default", async () => {
    store.entries.set("session-1", [
      ...Array.from({ length: 12 }, (_, i) =>
        user(`Question ${i + 1}!`, "2026-11-04T10:00:00.000Z"),
      ),
      call("call-pending", "message", { message: "Answer" }),
    ]);
    const text = await card();
    expect(text).toContain("2 earlier messages");
    expect(text).not.toContain("Question 1!");
    expect(text).not.toContain("Question 2!");
    expect(text).toContain("Question 3!");
    expect(text).toContain("Question 12!");
  });

  it("uses the recipient's conversation when the host requests a reply", async () => {
    const hostKey = "agent:host:whatsapp:direct:+447700900001";
    store.sessions.set(hostKey, "host-session");
    store.entries.set("host-session", [
      user("Private host instruction", "2026-11-04T10:15:00.000Z"),
      call("call-pending", "message", { target: GUEST, message: "Confirmed" }),
    ]);
    store.entries.set("session-1", [user("Guest question", "2026-11-04T10:05:00.000Z")]);
    const text = await card(
      undefined,
      request({ sessionKey: hostKey, agentId: "host", turnSourceTo: "+447700900001" }),
    );
    expect(text).toContain(`📥 ${GUEST}\n10:05 Guest question`);
    expect(text).not.toContain("Private host instruction");
    store.sessions.delete(SESSION_KEY);
    const firstContact = await card(
      undefined,
      request({ sessionKey: hostKey, agentId: "host", turnSourceTo: "+447700900001" }),
    );
    expect(firstContact).toContain("Confirmed");
    expect(firstContact).not.toContain("📥");
    expect(firstContact).not.toContain("Private host instruction");
  });

  it("keeps guest questions unanswered when a message was sent to someone else", async () => {
    store.entries.set("session-1", [
      user("Guest question", "2026-11-04T10:00:00.000Z"),
      call("notify-host", "message", { target: "+447700900001", message: "Please check" }),
      result("notify-host", '{"status":"ok"}'),
      call("call-pending", "message", { target: GUEST, message: "Answer" }),
    ]);
    expect(await card()).toContain("Guest question");
  });

  it.each([
    {
      role: "custom",
      customType: "whatsapp.history",
      content: [{ type: "text", text: "Business phone: Answered" }],
    },
    {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Answered" }],
    },
  ])("starts unanswered context after a delivered business reply: $role", async (message) => {
    store.entries.set("session-1", [
      user("Already answered", "2026-11-04T10:00:00.000Z"),
      { type: "message", message },
      user("New question", "2026-11-04T10:05:00.000Z"),
      call("call-pending", "message", { target: GUEST, message: "Answer" }),
    ]);
    const text = await card();
    expect(text).not.toContain("Already answered");
    expect(text).toContain("New question");
  });

  it("shows the unanswered messages, then exactly the send the approval holds", async () => {
    expect(await card({ approvalLanguage: "es" })).toBe(
      [
        `📥 ${GUEST}\n10:05 ¿Cuánto cuesta una noche más?\n10:12 ¿Hay respuesta?`,
        "¿Enviar mensaje?",
        `Para: ${GUEST}`,
        "Una noche más cuesta 3200 MXN.",
        "media: https://example.com/rate.pdf",
        "El asistente pide revisión.",
        "👍 Enviar · 👎 Rechazar · 5 min",
      ].join("\n\n"),
    );
  });

  it("names the target the call sends to, not the chat it came from", async () => {
    store.entries.set("session-1", [
      call("call-pending", "message", { target: "owner", message: "Hola" }),
    ]);
    expect(await card()).toContain("To: owner");
  });

  it("shows the newest messages up to the limit and counts the earlier ones", async () => {
    const text = await card({ approvalLanguage: "es", approvalUnansweredMessageLimit: 1 });
    expect(text).toContain(`📥 ${GUEST}\n… 1 mensaje anterior\n10:12 ¿Hay respuesta?`);
  });

  it.each([
    ["en", 'Message action "react"?\n\nTo: +15550000300\n\nemoji: 👍'],
    ["es", '¿Acción de mensaje "react"?\n\nPara: +15550000300\n\nemoji: 👍'],
  ])("names_an_action_other_than_send_%s", async (approvalLanguage, expected) => {
    store.entries.set("session-1", [
      call("call-pending", "message", { action: "react", emoji: "👍", messageId: "m-1" }),
    ]);
    const text = await card({ approvalLanguage });
    expect(text).toContain(expected);
    expect(text).not.toContain("Send message?");
    expect(text).not.toContain("¿Enviar mensaje?");
  });

  it.each([
    ["en", "👍"],
    ["es", "👍 Enviar · 👎 Rechazar"],
  ])("ends_with_the_footer_the_outcome_replaces_%s", async (approvalLanguage, reactions) => {
    const built = await cardWithFooter({ approvalLanguage });
    expect(built?.footer).toContain(reactions);
    expect(built?.text.endsWith(`\n\n${built.footer}`)).toBe(true);
  });

  it("says when the send carries no text", async () => {
    store.entries.set("session-1", [call("call-pending", "message", { action: "send" })]);
    expect(await card()).toContain("Send message?\n\nTo: +15550000300\n\n(no text)");
  });

  it.each([
    ["the session is gone", () => store.sessions.clear()],
    ["the transcript holds no such call", () => store.entries.set("session-1", [])],
  ])("is undefined when %s", async (_label, change) => {
    change();
    expect(await card()).toBeUndefined();
  });

  it("shows a written \\n as the line break OpenClaw sends", async () => {
    store.entries.set("session-1", [
      call("call-pending", "message", { message: "Código ABC\\nDEF" }),
    ]);
    expect(await card()).toContain("Código ABC\nDEF");
  });

  it("shows hidden characters as codes and cuts a long guest message", async () => {
    store.entries.set("session-1", [
      user(`${"a".repeat(301)}\u202e`, "2026-11-04T10:00:00.000Z"),
      call("call-pending", "message", { message: "Pago\u202eNXM 0023\u3164\nGracias 👨\u200d👩" }),
    ]);
    const text = await card();
    expect(text).toContain(`10:00 ${"a".repeat(300)}…`);
    expect(text).toContain("Pago\\u{202e}NXM 0023\\u{3164}\nGracias 👨\u200d👩");
  });

  it("reads only the branch the call is on, not an abandoned one", async () => {
    store.entries.set("session-1", [
      user("Rama vieja", "2026-11-04T10:00:00.000Z"),
      { ...user("Rama actual", "2026-11-04T10:01:00.000Z"), id: "kept", parentId: "e0" },
      {
        ...call("call-pending", "message", { message: "Hola" }),
        id: "pending",
        parentId: "kept",
      },
    ]);
    const text = await card();
    expect(text).toContain("10:01 Rama actual");
    expect(text).not.toContain("Rama vieja");
  });

  it("is undefined for a request without a session or tool call", async () => {
    expect(await card(undefined, request({ sessionKey: undefined }))).toBeUndefined();
    expect(await card(undefined, request({ toolCallId: undefined }))).toBeUndefined();
  });
});

describe("isWhatsAppMessageApproval", () => {
  it("is true only for the message tool", () => {
    expect(isWhatsAppMessageApproval(request())).toBe(true);
    expect(isWhatsAppMessageApproval(request({ toolName: "pms__find" }))).toBe(false);
  });
});
