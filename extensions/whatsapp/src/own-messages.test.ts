import type { proto, WAMessage } from "baileys";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { rememberRecentOutboundMessage, resetWebInboundDedupe } from "./inbound/dedupe.js";
import { createWhatsAppOwnMessageHandler } from "./inbound/own-message-delivery.js";
import { rememberWhatsAppSentMessage } from "./inbound/sent-message-store.js";
import {
  registerWhatsAppOwnMessageHistory,
  recordWhatsAppOwnMessageHistory,
} from "./own-message-history.js";
import {
  classifyWhatsAppOwnMessage,
  formatWhatsAppOwnMessageTurnBody,
  type WhatsAppOwnMessage,
} from "./own-messages.js";

const memoryState = vi.hoisted(() => ({ namespaces: new Map<string, Map<string, unknown>>() }));
const appendTranscript = vi.hoisted(() =>
  vi.fn(async (_args: { message: { timestamp: number } }) => ({ kind: "result" as const })),
);

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

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => ({
    session: { dmScope: "per-account-channel-peer" },
    channels: { whatsapp: {} },
  }),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>()),
  appendSessionTranscriptMessageByIdentityStrict: appendTranscript,
}));

const accessControl = vi.hoisted(() => ({ checkInboundAccessControl: vi.fn() }));
vi.mock("./inbound/access-control.js", () => accessControl);

const SELF = "+15550000100";
const SELF_JID = "15550000100@s.whatsapp.net";
const CONTACT = "+15550000300";
const CONTACT_JID = "15550000300@s.whatsapp.net";
const OWNER = "+15550000200";
const TIMESTAMP_SECONDS = 1_760_000_000;

async function runGatewayStart(): Promise<void> {
  let handler: (() => Promise<void>) | undefined;
  registerWhatsAppOwnMessageHistory({
    on: (_name: string, callback: () => Promise<void>) => {
      handler = callback;
    },
  } as unknown as OpenClawPluginApi);
  if (!handler) {
    throw new Error("WhatsApp history gateway_start handler was not registered");
  }
  await handler();
}

const E164_BY_JID: Record<string, string> = { [SELF_JID]: SELF, [CONTACT_JID]: CONTACT };
const resolveInboundJid = async (jid: string | null | undefined) =>
  jid ? (E164_BY_JID[jid] ?? null) : null;

function phoneMessage(
  overrides: {
    remoteJid?: string;
    id?: string;
    fromMe?: boolean;
    message?: proto.IMessage;
  } = {},
): WAMessage {
  return {
    key: {
      remoteJid: overrides.remoteJid ?? CONTACT_JID,
      id: overrides.id ?? "own-1",
      fromMe: overrides.fromMe ?? true,
    },
    message: overrides.message ?? { conversation: "The report is ready on Mondays." },
    messageTimestamp: TIMESTAMP_SECONDS,
  } as WAMessage;
}

function classify(msg: WAMessage, upsertType = "notify") {
  return classifyWhatsAppOwnMessage({
    msg,
    upsertType,
    accountId: "default",
    selfE164: SELF,
    timestampMs: TIMESTAMP_SECONDS * 1000,
    resolveInboundJid,
    logVerbose: () => {},
  });
}

beforeEach(() => {
  appendTranscript.mockReset().mockResolvedValue({ kind: "result" });
  resetWebInboundDedupe();
  for (const entries of memoryState.namespaces.values()) {
    entries.clear();
  }
  accessControl.checkInboundAccessControl.mockReset();
});

// The owner turn's body for CONTACT's "The report is ready on Mondays.", as
// OpenClaw's envelope writes a message the account sent.
const OWN_TURN_BODY = new RegExp(
  `^\\[WhatsApp \\${CONTACT}[^\\]]*\\] \\(self\\): The report is ready on Mondays\\.$`,
);

describe("ownMessages config", () => {
  it.each([
    { name: "off", value: "off", ok: true },
    { name: "history", value: "history", ok: true },
    { name: "turn", value: "turn", ok: true },
    { name: "unknown_mode", value: "all", ok: false },
    { name: "object_form", value: { mode: "turn" }, ok: false },
  ])("$name", ({ value, ok }) => {
    expect(WhatsAppConfigSchema.safeParse({ ownMessages: value }).success).toBe(ok);
    expect(
      WhatsAppConfigSchema.safeParse({ accounts: { biz: { ownMessages: value } } }).success,
    ).toBe(ok);
  });
});

describe("own message detection", () => {
  it("classifies a live message typed on the phone to a contact", async () => {
    await expect(classify(phoneMessage())).resolves.toEqual({
      accountId: "default",
      messageId: "own-1",
      chatJid: CONTACT_JID,
      peerE164: CONTACT,
      timestampMs: TIMESTAMP_SECONDS * 1000,
      text: "The report is ready on Mondays.",
      mediaKind: undefined,
    });
  });

  it("classifies wrapped text and media-only messages", async () => {
    await expect(
      classify(
        phoneMessage({
          message: { ephemeralMessage: { message: { extendedTextMessage: { text: "Wrapped" } } } },
        }),
      ),
    ).resolves.toMatchObject({ text: "Wrapped" });
    await expect(
      classify(phoneMessage({ message: { imageMessage: { mimetype: "image/jpeg" } } })),
    ).resolves.toMatchObject({ text: "", mediaKind: "image" });
  });

  it.each([
    { name: "received_from_the_contact", msg: phoneMessage({ fromMe: false }) },
    { name: "group_chat", msg: phoneMessage({ remoteJid: "120363401234567890@g.us" }) },
    { name: "status_broadcast", msg: phoneMessage({ remoteJid: "status@broadcast" }) },
    { name: "own_chat", msg: phoneMessage({ remoteJid: SELF_JID }) },
    { name: "unresolvable_lid", msg: phoneMessage({ remoteJid: "987654321@lid" }) },
    {
      name: "reaction",
      msg: phoneMessage({
        message: {
          reactionMessage: { text: "👍", key: { remoteJid: CONTACT_JID, id: "contact-1" } },
        },
      }),
    },
    {
      name: "edit",
      msg: phoneMessage({
        message: {
          protocolMessage: {
            type: 14,
            key: { remoteJid: CONTACT_JID, id: "own-0", fromMe: true },
            editedMessage: { conversation: "Edited text" },
          },
        },
      }),
    },
    {
      name: "wrapped_edit",
      msg: phoneMessage({
        message: {
          editedMessage: {
            message: {
              protocolMessage: { type: 14, editedMessage: { conversation: "Edited text" } },
            },
          },
        },
      }),
    },
    {
      // Baileys unwraps editedMessage like a plain wrapper, so only the explicit rule stops it.
      name: "edit_wrapper_around_plain_content",
      msg: phoneMessage({
        message: { editedMessage: { message: { conversation: "Edited text" } } },
      }),
    },
    {
      name: "delete",
      msg: phoneMessage({
        message: { protocolMessage: { type: 0, key: { remoteJid: CONTACT_JID, id: "own-0" } } },
      }),
    },
    {
      name: "poll_vote",
      msg: phoneMessage({ message: { pollUpdateMessage: { pollCreationMessageKey: {} } } }),
    },
  ])("ignores $name", async ({ msg }) => {
    await expect(classify(msg)).resolves.toBeNull();
  });

  it("ignores offline backfill and history sync, which Baileys upserts as append", async () => {
    await expect(classify(phoneMessage(), "append")).resolves.toBeNull();
  });

  it("ignores the echo of a message this plugin sent", async () => {
    rememberRecentOutboundMessage({
      accountId: "default",
      remoteJid: CONTACT_JID,
      messageId: "own-1",
    });

    await expect(classify(phoneMessage())).resolves.toBeNull();
  });

  it("ignores the echo after a restart cleared the in-memory echo cache", async () => {
    rememberWhatsAppSentMessage({
      accountId: "default",
      remoteJid: CONTACT_JID,
      messageId: "own-1",
    });
    await Promise.resolve();
    resetWebInboundDedupe();

    await expect(classify(phoneMessage())).resolves.toBeNull();
    await expect(classify(phoneMessage({ id: "own-2" }))).resolves.toMatchObject({
      messageId: "own-2",
    });
  });

  it("formats the owner turn body as OpenClaw writes a message the account sent", () => {
    const body = formatWhatsAppOwnMessageTurnBody(
      {
        peerE164: CONTACT,
        timestampMs: 1_760_000_000_000,
        text: "See you at 4",
        mediaKind: "image",
      },
      { timezone: "utc" },
    );
    expect(body).toBe(
      `[WhatsApp ${CONTACT} Thu 2025-10-09T08:53:20Z] (self): See you at 4\n<media:image>`,
    );
  });
});

describe("own message history store", () => {
  const own = (overrides: Partial<WhatsAppOwnMessage>): WhatsAppOwnMessage => ({
    accountId: "default",
    messageId: "own-1",
    chatJid: CONTACT_JID,
    peerE164: CONTACT,
    timestampMs: 1000,
    text: "text",
    ...overrides,
  });

  it("retains failed appends and drains them in timestamp order", async () => {
    appendTranscript.mockRejectedValueOnce(new Error("transcript unavailable"));
    await expect(
      recordWhatsAppOwnMessageHistory(own({ messageId: "b", timestampMs: 2000 })),
    ).rejects.toThrow();
    appendTranscript.mockRejectedValueOnce(new Error("transcript unavailable"));
    await expect(
      recordWhatsAppOwnMessageHistory(own({ messageId: "a", timestampMs: 1000 })),
    ).rejects.toThrow();

    appendTranscript.mockClear();
    await runGatewayStart();

    expect(appendTranscript.mock.calls.map(([args]) => args.message.timestamp)).toEqual([
      1000, 2000,
    ]);
  });
});

describe("own message handler", () => {
  const enqueue = vi.fn(async () => {});
  const createChatTransport = vi.fn((chatJid: string) => ({
    sendComposing: async () => {},
    reply: vi.fn(async () => ({ chatJid }) as never),
    sendMedia: vi.fn(async () => ({ chatJid }) as never),
  }));

  function handler(
    ownMessages: string | undefined,
    ownerAllowFrom: string[] = ["telegram:123456789", `whatsapp:${OWNER}`, "+15550000999"],
  ) {
    return createWhatsAppOwnMessageHandler({
      cfg: {
        commands: { ownerAllowFrom },
        channels: {
          whatsapp: {
            dmPolicy: "allowlist",
            allowFrom: [OWNER, CONTACT],
            ...(ownMessages ? { ownMessages } : {}),
          },
        },
      } as never,
      accountId: "default",
      verbose: false,
      self: { e164: SELF, jid: SELF_JID, lid: null },
      resolveInboundJid,
      sendTrackedMessage: vi.fn() as never,
      createChatTransport,
      enqueue,
      parseTimestampSeconds: (value) => Number(value),
      logVerbose: () => {},
      logWarn: vi.fn(),
    });
  }

  const context = { upsertType: "notify", receivedAt: 5, receiveOrder: 7 };
  const lifecycle = { complete: vi.fn() } as never;
  const pendingHistoryCount = () =>
    memoryState.namespaces.get("whatsapp.own-message-history")?.size ?? 0;

  beforeEach(() => {
    enqueue.mockClear();
    createChatTransport.mockClear();
  });

  it("leaves own messages to the upstream path when mode is off", async () => {
    await expect(handler(undefined)(phoneMessage(), context, lifecycle)).resolves.toBeUndefined();
    await expect(handler("off")(phoneMessage(), context, lifecycle)).resolves.toBeUndefined();
    expect(pendingHistoryCount()).toBe(0);
  });

  it("records history and starts no turn in history mode", async () => {
    await expect(handler("history")(phoneMessage(), context, lifecycle)).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    expect(accessControl.checkInboundAccessControl).not.toHaveBeenCalled();
    expect(pendingHistoryCount()).toBe(0);
  });

  it("starts one owner turn with the (self) envelope and channelContext.chat.ownMessage", async () => {
    const admission = { accountId: "default", conversation: { kind: "direct", id: OWNER } };
    accessControl.checkInboundAccessControl.mockResolvedValue({ allowed: true, admission });

    await expect(handler("turn")(phoneMessage(), context, lifecycle)).resolves.toBe("deferred");

    expect(accessControl.checkInboundAccessControl).toHaveBeenCalledWith(
      expect.objectContaining({
        from: OWNER,
        senderE164: OWNER,
        isFromMe: false,
        group: false,
        suppressPairingChallenge: true,
        remoteJid: "15550000200@s.whatsapp.net",
      }),
    );
    expect(createChatTransport).toHaveBeenCalledWith("15550000200@s.whatsapp.net");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        admission,
        event: { timestamp: TIMESTAMP_SECONDS * 1000 },
        payload: {
          body: expect.stringMatching(OWN_TURN_BODY),
          commandBody: expect.stringMatching(OWN_TURN_BODY),
        },
        platform: expect.objectContaining({
          chatJid: "15550000200@s.whatsapp.net",
          senderE164: OWNER,
          fromMe: false,
        }),
        ownMessage: {
          messageId: "own-1",
          peerE164: CONTACT,
          timestampMs: TIMESTAMP_SECONDS * 1000,
        },
        turnAdoptionLifecycle: lifecycle,
        receiveOrder: 7,
      }),
    );
    expect(pendingHistoryCount()).toBe(0);
  });

  it("starts no turn when commands.ownerAllowFrom names no WhatsApp owner", async () => {
    await expect(
      handler("turn", ["telegram:123456789", "*"])(phoneMessage(), context, lifecycle),
    ).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    expect(pendingHistoryCount()).toBe(0);
  });

  it("starts no turn when the owner is not admitted", async () => {
    accessControl.checkInboundAccessControl.mockResolvedValue({ allowed: false });

    await expect(handler("turn")(phoneMessage(), context, lifecycle)).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    expect(pendingHistoryCount()).toBe(0);
  });

  it("leaves echoes, groups and backfill to the upstream path", async () => {
    rememberRecentOutboundMessage({
      accountId: "default",
      remoteJid: CONTACT_JID,
      messageId: "echo",
    });
    const turn = handler("turn");

    for (const [msg, upsertType] of [
      [phoneMessage({ id: "echo" }), "notify"],
      [phoneMessage({ remoteJid: "120363401234567890@g.us" }), "notify"],
      [phoneMessage(), "append"],
    ] as const) {
      await expect(turn(msg, { ...context, upsertType }, lifecycle)).resolves.toBeUndefined();
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(pendingHistoryCount()).toBe(0);
  });
});
