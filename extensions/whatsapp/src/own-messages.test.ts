import type { proto, WAMessage } from "baileys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import { rememberRecentOutboundMessage, resetWebInboundDedupe } from "./inbound/dedupe.js";
import { createWhatsAppOwnMessageHandler } from "./inbound/own-message-delivery.js";
import { rememberWhatsAppSentMessage } from "./inbound/sent-message-store.js";
import {
  deleteWhatsAppOwnMessageHistory,
  listWhatsAppOwnMessageHistory,
  recordWhatsAppOwnMessageHistory,
} from "./own-message-history.js";
import {
  classifyWhatsAppOwnMessage,
  formatWhatsAppOwnMessageTurnBody,
  type WhatsAppOwnMessage,
} from "./own-messages.js";

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

const accessControl = vi.hoisted(() => ({ checkInboundAccessControl: vi.fn() }));
vi.mock("./inbound/access-control.js", () => accessControl);

const SELF = "+15550000100";
const SELF_JID = "15550000100@s.whatsapp.net";
const GUEST = "+15550000300";
const GUEST_JID = "15550000300@s.whatsapp.net";
const OWNER = "+15550000200";
const TIMESTAMP_SECONDS = 1_760_000_000;

const E164_BY_JID: Record<string, string> = { [SELF_JID]: SELF, [GUEST_JID]: GUEST };
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
      remoteJid: overrides.remoteJid ?? GUEST_JID,
      id: overrides.id ?? "own-1",
      fromMe: overrides.fromMe ?? true,
    },
    message: overrides.message ?? { conversation: "The pool is cleaned on Mondays." },
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
  resetWebInboundDedupe();
  for (const entries of memoryState.namespaces.values()) {
    entries.clear();
  }
  accessControl.checkInboundAccessControl.mockReset();
});

// The owner turn's body for GUEST's "The pool is cleaned on Mondays.", as
// OpenClaw's envelope writes a message the account sent.
const OWN_TURN_BODY = new RegExp(
  `^\\[WhatsApp \\${GUEST}[^\\]]*\\] \\(self\\): The pool is cleaned on Mondays\\.$`,
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
  it("classifies a live message typed on the phone to a guest", async () => {
    await expect(classify(phoneMessage())).resolves.toEqual({
      accountId: "default",
      messageId: "own-1",
      chatJid: GUEST_JID,
      peerE164: GUEST,
      timestampMs: TIMESTAMP_SECONDS * 1000,
      text: "The pool is cleaned on Mondays.",
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
    { name: "received_from_the_guest", msg: phoneMessage({ fromMe: false }) },
    { name: "group_chat", msg: phoneMessage({ remoteJid: "120363401234567890@g.us" }) },
    { name: "status_broadcast", msg: phoneMessage({ remoteJid: "status@broadcast" }) },
    { name: "own_chat", msg: phoneMessage({ remoteJid: SELF_JID }) },
    { name: "unresolvable_lid", msg: phoneMessage({ remoteJid: "987654321@lid" }) },
    {
      name: "reaction",
      msg: phoneMessage({
        message: { reactionMessage: { text: "👍", key: { remoteJid: GUEST_JID, id: "guest-1" } } },
      }),
    },
    {
      name: "edit",
      msg: phoneMessage({
        message: {
          protocolMessage: {
            type: 14,
            key: { remoteJid: GUEST_JID, id: "own-0", fromMe: true },
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
        message: { protocolMessage: { type: 0, key: { remoteJid: GUEST_JID, id: "own-0" } } },
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
      remoteJid: GUEST_JID,
      messageId: "own-1",
    });

    await expect(classify(phoneMessage())).resolves.toBeNull();
  });

  it("ignores the echo after a restart cleared the in-memory echo cache", async () => {
    rememberWhatsAppSentMessage({ accountId: "default", remoteJid: GUEST_JID, messageId: "own-1" });
    await Promise.resolve();
    resetWebInboundDedupe();

    await expect(classify(phoneMessage())).resolves.toBeNull();
    await expect(classify(phoneMessage({ id: "own-2" }))).resolves.toMatchObject({
      messageId: "own-2",
    });
  });

  it("formats the owner turn body as OpenClaw writes a message the account sent", () => {
    const body = formatWhatsAppOwnMessageTurnBody(
      { peerE164: GUEST, timestampMs: 1_760_000_000_000, text: "See you at 4", mediaKind: "image" },
      { timezone: "utc" },
    );
    expect(body).toBe(
      `[WhatsApp ${GUEST} Thu 2025-10-09T08:53:20Z] (self): See you at 4\n<media:image>`,
    );
  });
});

describe("own message history store", () => {
  const own = (overrides: Partial<WhatsAppOwnMessage>): WhatsAppOwnMessage => ({
    accountId: "default",
    messageId: "own-1",
    chatJid: GUEST_JID,
    peerE164: GUEST,
    timestampMs: 1000,
    text: "text",
    ...overrides,
  });

  it("lists one chat's pending messages oldest first and deletes consumed keys", async () => {
    await recordWhatsAppOwnMessageHistory(own({ messageId: "b", timestampMs: 2000 }));
    await recordWhatsAppOwnMessageHistory(own({ messageId: "a", timestampMs: 1000 }));
    await recordWhatsAppOwnMessageHistory(own({ messageId: "c", timestampMs: 3000 }));
    await recordWhatsAppOwnMessageHistory(own({ messageId: "x", peerE164: "+15550000999" }));
    await recordWhatsAppOwnMessageHistory(own({ messageId: "y", accountId: "default:other" }));

    const listed = await listWhatsAppOwnMessageHistory({ accountId: "default", peerE164: GUEST });

    expect(listed.map(({ message }) => message.messageId)).toEqual(["a", "b", "c"]);
    await deleteWhatsAppOwnMessageHistory(listed.slice(1).map(({ key }) => key));
    await expect(
      listWhatsAppOwnMessageHistory({ accountId: "default", peerE164: GUEST }),
    ).resolves.toEqual([
      expect.objectContaining({ message: expect.objectContaining({ messageId: "a" }) }),
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
            allowFrom: [OWNER, GUEST],
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
  const pendingHistory = () =>
    listWhatsAppOwnMessageHistory({ accountId: "default", peerE164: GUEST });

  beforeEach(() => {
    enqueue.mockClear();
    createChatTransport.mockClear();
  });

  it("leaves own messages to the upstream path when mode is off", async () => {
    await expect(handler(undefined)(phoneMessage(), context, lifecycle)).resolves.toBeUndefined();
    await expect(handler("off")(phoneMessage(), context, lifecycle)).resolves.toBeUndefined();
    await expect(pendingHistory()).resolves.toEqual([]);
  });

  it("records history and starts no turn in history mode", async () => {
    await expect(handler("history")(phoneMessage(), context, lifecycle)).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    expect(accessControl.checkInboundAccessControl).not.toHaveBeenCalled();
    await expect(pendingHistory()).resolves.toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          messageId: "own-1",
          text: "The pool is cleaned on Mondays.",
        }),
      }),
    ]);
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
          peerE164: GUEST,
          timestampMs: TIMESTAMP_SECONDS * 1000,
        },
        turnAdoptionLifecycle: lifecycle,
        receiveOrder: 7,
      }),
    );
    await expect(pendingHistory()).resolves.toHaveLength(1);
  });

  it("starts no turn when commands.ownerAllowFrom names no WhatsApp owner", async () => {
    await expect(
      handler("turn", ["telegram:123456789", "*"])(phoneMessage(), context, lifecycle),
    ).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    await expect(pendingHistory()).resolves.toHaveLength(1);
  });

  it("starts no turn when the owner is not admitted", async () => {
    accessControl.checkInboundAccessControl.mockResolvedValue({ allowed: false });

    await expect(handler("turn")(phoneMessage(), context, lifecycle)).resolves.toBe("completed");

    expect(enqueue).not.toHaveBeenCalled();
    await expect(pendingHistory()).resolves.toHaveLength(1);
  });

  it("leaves echoes, groups and backfill to the upstream path", async () => {
    rememberRecentOutboundMessage({
      accountId: "default",
      remoteJid: GUEST_JID,
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
    await expect(pendingHistory()).resolves.toEqual([]);
  });
});
