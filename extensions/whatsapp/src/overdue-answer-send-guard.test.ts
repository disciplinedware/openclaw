// A send that would reach a person whose answer is overdue is refused at the call; the owner may
// always be written to, and the owner's own run may write to anyone.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWhatsAppApprovalCardDeclined } from "./approval-cards.js";
import { createWhatsAppRecipientResolver } from "./inbound/recipient-resolver.js";
import { createTestWhatsAppRecipientResolver } from "./inbound/recipient-resolver.test-helper.js";
import { registerWhatsAppOverdueAnswerSendGuard } from "./overdue-answer-send-guard.js";
import {
  recordWhatsAppAnswer,
  recordWhatsAppUnansweredMessage,
  consumeWhatsAppTurnSend,
} from "./overdue-answers.js";

const memoryState = vi.hoisted(() => ({ namespaces: new Map<string, Map<string, unknown>>() }));

vi.mock("./runtime.js", async (importOriginal) => {
  const { createMemoryPluginStateRuntime } = await import("./plugin-state.test-helper.js");
  const state = createMemoryPluginStateRuntime();
  memoryState.namespaces = state.namespaces;
  return {
    ...(await importOriginal<typeof import("./runtime.js")>()),
    getWhatsAppRuntime: () => state.runtime,
    getOptionalWhatsAppRuntime: () => state.runtime,
  };
});

// The live connection of each account, which resolves a number to the person WhatsApp registered.
const liveListeners = vi.hoisted(() => new Map<string, { recipients: unknown }>());
vi.mock("./active-listener.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-listener.js")>()),

  getActiveWebListener: (accountId: string) => liveListeners.get(accountId) ?? null,
}));

const runtimeConfig = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),

  getRuntimeConfig: () => runtimeConfig.current,
}));

const OWNER = "+15550000200";
const CONTACT = "+15550000300";
const OTHER_CONTACT = "+15550000400";
const MINUTE_MS = 60_000;

const CFG: OpenClawConfig = {
  session: { dmScope: "per-account-channel-peer" },
  commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] },
  channels: { whatsapp: {} },
};

const directSession = (cfg: OpenClawConfig, peer: string) =>
  resolveAgentRoute({
    cfg,
    channel: "whatsapp",
    accountId: "default",
    peer: { kind: "direct", id: peer },
  }).sessionKey;

type ToolCall = { toolName: string; params: Record<string, unknown> };
type ToolContext = {
  sessionKey?: string;
  runId?: string;
  channelId?: string;
  requester?: { channel?: string; accountId?: string; senderId?: string };
};
type BeforeToolCall = (
  event: ToolCall,
  ctx: ToolContext,
) => Promise<{ block: true; blockReason: string } | undefined>;

const hooks = new Map<string, BeforeToolCall>();
registerWhatsAppOverdueAnswerSendGuard({
  on: (hookName: string, handler: BeforeToolCall) => hooks.set(hookName, handler),
} as unknown as OpenClawPluginApi);

/** Fires the hook the plugin registered, as OpenClaw does when the model calls a tool. */
const check = (call: ToolCall, ctx: ToolContext) => {
  const beforeToolCall = hooks.get("before_tool_call");
  if (!beforeToolCall) {
    throw new Error("before_tool_call is not registered");
  }
  return beforeToolCall(call, ctx);
};

/** The context of a run in a person's own direct chat. */
const runOf = (peer: string, cfg: OpenClawConfig = CFG): ToolContext => ({
  sessionKey: directSession(cfg, peer),
  channelId: peer,
  requester: { channel: "whatsapp", accountId: "default", senderId: peer },
});

const message = (params: Record<string, unknown>): ToolCall => ({ toolName: "message", params });
const send = (params: Record<string, unknown>): ToolCall =>
  message({ action: "send", message: "Sorry for the delay.", ...params });

/** Records a message of `peer` sent `minutes` ago, as the inbound path does. */
const contactWrote = (peer: string, minutes: number) =>
  recordWhatsAppUnansweredMessage(
    { accountId: "default", personE164: peer },
    { sentAtMs: Date.now() - minutes * MINUTE_MS, receivedAtMs: Date.now() },
  );

// WhatsApp registers this Mexican mobile as 521…; a system of record stores it as +52….
const MX_STORED = "+525500000000";
const MX_REGISTERED = "+5215500000000";

beforeEach(() => {
  runtimeConfig.current = CFG;
  liveListeners.clear();
  liveListeners.set("default", {
    recipients: createTestWhatsAppRecipientResolver({
      "525500000000@s.whatsapp.net": "5215500000000@s.whatsapp.net",
    }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const entries of memoryState.namespaces.values()) {
    entries.clear();
  }
});

const CFG_WITH_OVERDUE_BLOCKING_DISABLED: OpenClawConfig = {
  ...CFG,
  plugins: {
    entries: {
      "whatsapp-for-business": { config: { blockOverdueAnswers: false } },
    },
  },
};
const CFG_WITH_OVERDUE_BLOCKING_ENABLED: OpenClawConfig = {
  ...CFG,
  plugins: {
    entries: {
      "whatsapp-for-business": { config: { blockOverdueAnswers: true } },
    },
  },
};

describe("overdue answer send guard", () => {
  it.each([
    { name: "default", cfg: CFG },
    { name: "true", cfg: CFG_WITH_OVERDUE_BLOCKING_ENABLED },
  ])(
    "blocks an overdue send with the $name setting through the registered hook",
    async ({ cfg }) => {
      runtimeConfig.current = cfg;
      await contactWrote(CONTACT, 20);

      await expect(
        check(send({ target: CONTACT }), runOf(OTHER_CONTACT, cfg)),
      ).resolves.toMatchObject({
        block: true,
        blockReason: expect.stringContaining("overdue"),
      });
    },
  );

  it("allows an overdue send when disabled and retains state for the approval policy", async () => {
    runtimeConfig.current = CFG_WITH_OVERDUE_BLOCKING_DISABLED;
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), runOf(OTHER_CONTACT))).resolves.toBeUndefined();

    runtimeConfig.current = CFG;
    await expect(check(send({ target: CONTACT }), runOf(OTHER_CONTACT))).resolves.toMatchObject({
      block: true,
      blockReason: expect.stringContaining("overdue"),
    });
  });

  it("allows a send to a person whose message is 5 minutes old", async () => {
    await contactWrote(CONTACT, 5);

    await expect(check(send({}), runOf(CONTACT))).resolves.toBeUndefined();
    await expect(check(send({ target: CONTACT }), runOf(CONTACT))).resolves.toBeUndefined();
  });

  it.each([16, 20])(
    "refuses a send to a person whose message is %i minutes old, naming the time and the owner",
    async (minutes) => {
      vi.useFakeTimers({ now: Date.UTC(2026, 9, 17, 12, 0, 0), toFake: ["Date"] });
      await contactWrote(CONTACT, minutes);

      const result = await check(send({}), runOf(CONTACT));

      expect(result).toEqual({ block: true, blockReason: expect.any(String) });
      const sentAt = new Date(Date.now() - minutes * MINUTE_MS).toISOString();
      expect(result?.blockReason).toContain(sentAt.replace(/\.\d{3}Z$/, ""));
      expect(result?.blockReason).toContain("more than 15 minutes");
      expect(result?.blockReason).toContain(
        'only the owner can be written to (message target "owner")',
      );
    },
  );

  it.each([
    { name: "current_chat", call: send({}) },
    { name: "person_by_number", call: send({ target: CONTACT }) },
    { name: "person_by_jid", call: send({ to: "15550000300@s.whatsapp.net" }) },
    { name: "person_among_targets", call: send({ targets: ["owner", CONTACT] }) },
    { name: "person_by_channel_id", call: send({ target: "owner", channelId: CONTACT }) },
    { name: "attachment", call: message({ action: "upload-file", media: "/tmp/a.jpg" }) },
    { name: "poll", call: message({ action: "poll", pollQuestion: "Move the call to Friday?" }) },
    { name: "reaction", call: message({ action: "react", emoji: "👍" }) },
    {
      name: "broadcast",
      call: message({ action: "broadcast", message: "The office is closed today." }),
    },
    { name: "unknown_action", call: message({ action: "nudge", message: "Are you there?" }) },
    { name: "missing_action", call: message({ message: "Sorry for the delay." }) },
    { name: "voice_call", call: { toolName: "whatsapp_call", params: { action: "call" } } },
  ])(
    "refuses a call that reaches an overdue person from their own run ($name)",
    async ({ call }) => {
      await contactWrote(CONTACT, 20);

      await expect(check(call, runOf(CONTACT))).resolves.toEqual({
        block: true,
        blockReason: expect.stringContaining("overdue"),
      });
    },
  );

  it.each([
    { name: "owner_target", call: send({ target: "owner" }) },
    { name: "owner_number", call: send({ target: `whatsapp:${OWNER}` }) },
    { name: "other_channel", call: send({ channel: "telegram", target: "123" }) },
    { name: "call_status", call: { toolName: "whatsapp_call", params: { action: "status" } } },
    { name: "read", call: message({ action: "read" }) },
    { name: "search", call: message({ action: "search", query: "invoice" }) },
    { name: "read_only_variant", call: message({ action: "List-Pins" }) },
    { name: "group", call: send({ target: "120363@g.us" }) },
  ])("allows $name from an overdue person's run", async ({ call }) => {
    await contactWrote(CONTACT, 20);

    await expect(check(call, runOf(CONTACT))).resolves.toBeUndefined();
  });

  it("lets the owner's own run write to an overdue person: the owner decided", async () => {
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), runOf(OWNER))).resolves.toBeUndefined();
  });

  it("refuses another contact's run that names the overdue person", async () => {
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), runOf(OTHER_CONTACT))).resolves.toEqual({
      block: true,
      blockReason: expect.stringContaining(CONTACT),
    });
  });

  it("refuses a run with no session, such as a subagent or a scheduled run", async () => {
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), {})).resolves.toEqual({
      block: true,
      blockReason: expect.any(String),
    });
  });

  it("refuses even the owner's run under dmScope main, where every direct chat shares one session", async () => {
    const mainCfg: OpenClawConfig = { ...CFG, session: { dmScope: "main" } };
    runtimeConfig.current = mainCfg;
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), runOf(OWNER, mainCfg))).resolves.toEqual({
      block: true,
      blockReason: expect.any(String),
    });
  });

  it("refuses a recipient it cannot read while anyone is overdue, and allows it otherwise", async () => {
    const unreadable = send({ target: "Alex" });

    await expect(check(unreadable, runOf(OTHER_CONTACT))).resolves.toBeUndefined();
    await contactWrote(CONTACT, 20);
    await expect(check(unreadable, runOf(OTHER_CONTACT))).resolves.toEqual({
      block: true,
      blockReason: expect.stringContaining("cannot be read"),
    });
  });

  it("checks at the call, so an approval wait after the call does not make the send overdue", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 17, 12, 0, 0), toFake: ["Date"] });
    await contactWrote(CONTACT, 0);
    vi.setSystemTime(Date.now() + 10 * MINUTE_MS);

    // Called at 10 minutes: allowed. Core then waits for the owner's approval and delivers later;
    // nothing on the delivery path reads the overdue state again.
    await expect(check(send({}), runOf(CONTACT))).resolves.toBeUndefined();

    vi.setSystemTime(Date.now() + 10 * MINUTE_MS);
    await expect(check(send({}), runOf(CONTACT))).resolves.toEqual({
      block: true,
      blockReason: expect.any(String),
    });
  });

  it("allows the person again once an answer reached them", async () => {
    await contactWrote(CONTACT, 20);
    await recordWhatsAppAnswer({ accountId: "default", personE164: CONTACT }, Date.now());

    await expect(check(send({}), runOf(CONTACT))).resolves.toBeUndefined();
  });

  it("reads the overdue state on the account the send goes through", async () => {
    await contactWrote(CONTACT, 20);

    await expect(
      check(send({ target: CONTACT, accountId: "second" }), runOf(OTHER_CONTACT)),
    ).resolves.toBeUndefined();
  });
  it("refuses a send to an overdue person named by another form of their number", async () => {
    await contactWrote(MX_REGISTERED, 20);

    await expect(check(send({ target: MX_STORED }), runOf(OTHER_CONTACT))).resolves.toEqual({
      block: true,
      blockReason: expect.stringContaining(`WhatsApp ${MX_REGISTERED}:`),
    });
  });

  it("lets the owner's run write to an overdue person named by another form of their number", async () => {
    await contactWrote(MX_REGISTERED, 20);

    await expect(check(send({ target: MX_STORED }), runOf(OWNER))).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "lookup_failed",
      recipients: { resolveE164: () => Promise.reject(new Error("timeout")) },
    },
    { name: "no_live_connection", recipients: undefined },
  ])(
    "refuses a number it cannot check with WhatsApp while anyone is overdue ($name)",
    async ({ recipients }) => {
      liveListeners.clear();
      if (recipients) {
        liveListeners.set("default", { recipients });
      }
      await contactWrote(MX_REGISTERED, 20);

      await expect(check(send({ target: OTHER_CONTACT }), runOf(OTHER_CONTACT))).resolves.toEqual({
        block: true,
        blockReason: expect.stringContaining("checked with WhatsApp"),
      });
    },
  );

  it("leaves a number WhatsApp has no account for to the send, which refuses it", async () => {
    liveListeners.set("default", {
      recipients: createWhatsAppRecipientResolver({ lookup: async () => [] }),
    });
    await contactWrote(CONTACT, 20);

    await expect(check(send({ target: CONTACT }), runOf(OTHER_CONTACT))).resolves.toBeUndefined();
  });
});

describe("the turn's sends, for the end of the turn", () => {
  it("records any call that reaches someone, the owner included", async () => {
    await check(send({ target: "owner" }), runOf(CONTACT));

    expect(consumeWhatsAppTurnSend(directSession(CFG, CONTACT))).toBe(true);
    expect(consumeWhatsAppTurnSend(directSession(CFG, CONTACT))).toBe(false);
  });

  it("records a send the guard refuses, since the person still waits", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 17, 12, 0, 0), toFake: ["Date"] });
    await contactWrote(CONTACT, 20);

    await expect(check(send({}), runOf(CONTACT))).resolves.toMatchObject({ block: true });
    expect(consumeWhatsAppTurnSend(directSession(CFG, CONTACT))).toBe(true);
  });

  it("records nothing for a read-only action or a run no person's message started", async () => {
    await check(message({ action: "read", messageId: "m1" }), runOf(CONTACT));
    await check(send({ target: "owner" }), { sessionKey: directSession(CFG, CONTACT) });

    expect(consumeWhatsAppTurnSend(directSession(CFG, CONTACT))).toBe(false);
  });
});

describe("declined proposal send guard", () => {
  const declineIn = (runId: string, recipient: string) =>
    recordWhatsAppApprovalCardDeclined({
      accountId: "default",
      remoteJid: "15550000200@s.whatsapp.net",
      messageId: `card-${runId}`,
      recipients: [recipient],
      sourceRunId: runId,
    });
  const endRun = (runId: string) =>
    (hooks.get("agent_end") as unknown as (event: unknown, ctx: { runId?: string }) => void)(
      {},
      { runId },
    );

  afterEach(() => {
    endRun("run-1");
  });

  it("refuses the run that got no approval when it proposes to the same person again", async () => {
    declineIn("run-1", CONTACT);

    const result = await check(send({ target: CONTACT }), { ...runOf(CONTACT), runId: "run-1" });

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("end the turn");
  });

  it("lets another run, and another recipient of the same run, through", async () => {
    declineIn("run-1", CONTACT);

    await expect(
      check(send({ target: CONTACT }), { ...runOf(CONTACT), runId: "run-2" }),
    ).resolves.toBeUndefined();
    await expect(
      check(send({ target: OTHER_CONTACT }), { ...runOf(OWNER), runId: "run-1" }),
    ).resolves.toBeUndefined();
  });

  it("knows the person under the number form a system of record stores", async () => {
    declineIn("run-1", MX_REGISTERED);

    const result = await check(send({ target: MX_STORED }), { ...runOf(OWNER), runId: "run-1" });

    expect(result?.block).toBe(true);
  });

  it("forgets a run once it ends", async () => {
    declineIn("run-1", CONTACT);
    endRun("run-1");

    await expect(
      check(send({ target: CONTACT }), { ...runOf(CONTACT), runId: "run-1" }),
    ).resolves.toBeUndefined();
  });
});
