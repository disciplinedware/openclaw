import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

const mocks = vi.hoisted(() => ({
  resolvePolicy: vi.fn(),
  prepared: vi.fn(),
  namespaces: new Map<string, Map<string, unknown>>(),
}));

vi.mock("../../runtime.js", async (importOriginal) => {
  const { createMemoryPluginStateRuntime } = await import("../../plugin-state.test-helper.js");
  const state = createMemoryPluginStateRuntime();
  mocks.namespaces = state.namespaces;
  return {
    ...(await importOriginal<typeof import("../../runtime.js")>()),
    getWhatsAppRuntime: () => state.runtime,
    getOptionalWhatsAppRuntime: () => state.runtime,
  };
});

vi.mock("../../inbound-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../inbound-policy.js")>()),
  resolveWhatsAppCommandAuthorized: async () => true,
  resolveWhatsAppInboundPolicy: mocks.resolvePolicy,
}));

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: async (
      params: Parameters<typeof actual.prepareWhatsAppInboundContext>[0],
    ) => {
      const prepared = await actual.prepareWhatsAppInboundContext(params);
      mocks.prepared(params, prepared.ctxPayload);
      return prepared;
    },
    createWhatsAppReplyPlan: (params: { replyResolver?: unknown }) => ({
      dispatcherOptions: {},
      delivery: { deliver: async () => {} },
      replyOptions: {},
      replyResolver: params.replyResolver,
      finalize: () => true,
    }),
    resolveWhatsAppResponsePrefix: () => undefined,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("./ack-reaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ack-reaction.js")>()),
  maybeSendAckReaction: async () => {},
}));

vi.mock("./last-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./last-route.js")>()),
  updateLastRouteInBackground: () => {},
}));

vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime-api.js")>()),
  createChannelMessageReplyPipeline: () => ({
    onModelSelected: () => {},
    responsePrefix: undefined,
  }),
  recordSessionMetaFromInbound: async () => {},
  resolveChannelContextVisibilityMode: () => "all",
  resolveInboundSessionEnvelopeContext: () => ({
    storePath: "/tmp",
    envelopeOptions: {},
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  shouldLogVerbose: () => false,
}));

import {
  listWhatsAppOwnMessageHistory,
  recordWhatsAppAssistantMessageHistory,
  recordWhatsAppOwnMessageHistory,
} from "../../own-message-history.js";
import { processMessage } from "./process-message.js";

const SELF = "+15550000100";
const OWNER = "+15550000200";
const GUEST = "+15550000300";
const GUEST_JID = "15550000300@s.whatsapp.net";

function policy(account: Record<string, unknown>) {
  return {
    account: { accountId: "default", authDir: "/tmp/wa-test-auth", ...account },
    dmPolicy: "allowlist",
    groupPolicy: "disabled",
    configuredAllowFrom: [OWNER, GUEST],
    dmAllowFrom: [OWNER, GUEST],
    groupAllowFrom: [],
    isSelfChat: false,
    providerMissingFallbackApplied: false,
    isSamePhone: () => false,
    resolveConversationGroupPolicy: () => "disabled",
    resolveConversationRequireMention: () => false,
  };
}

function directMessage(params: {
  peer: string;
  body: string;
  id?: string;
  ownMessage?: { messageId: string; peerE164: string; timestampMs: number };
}) {
  return createTestWebInboundMessage({
    event: { ...(params.id ? { id: params.id } : {}), timestamp: 1_760_000_100_000 },
    payload: { body: params.body },
    platform: {
      chatJid: `${params.peer.slice(1)}@s.whatsapp.net`,
      recipientJid: SELF,
      senderE164: params.peer,
      sender: { e164: params.peer },
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "r1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "m1"),
    },
    admission: {
      accountId: "default",
      conversation: { kind: "direct", id: params.peer },
      sender: { id: params.peer },
    },
    ...(params.ownMessage ? { ownMessage: params.ownMessage } : {}),
  });
}

async function runTurn(
  msg: ReturnType<typeof directMessage>,
  options: {
    dispatchReplyFromConfig?: Parameters<typeof processMessage>[0]["dispatchReplyFromConfig"];
    historyLimit?: number;
  } = {},
) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const peer = msg.admission.conversation.id;
  const turn = processMessage({
    cfg: {} as never,
    msg: msg as never,
    route: {
      agentId: "concierge",
      channel: "whatsapp",
      accountId: "default",
      sessionKey: `agent:concierge:whatsapp:direct:${peer}`,
      mainSessionKey: "agent:concierge:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    } as never,
    groupHistoryKey: `agent:concierge:whatsapp:direct:${peer}`,
    groupHistoryLimit: options.historyLimit ?? 20,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    dispatchReplyFromConfig:
      options.dispatchReplyFromConfig ??
      (async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } })),
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks,
  });
  try {
    await turn;
  } finally {
    await Promise.allSettled(backgroundTasks);
  }
}

const preparedCall = () => {
  const call = mocks.prepared.mock.calls.at(-1);
  if (!call) {
    throw new Error("prepareWhatsAppInboundContext was not called");
  }
  return {
    params: call[0] as {
      combinedBody: string;
      directHistory?: unknown[];
      replyThreading?: unknown;
    },
    ctx: call[1] as Record<string, unknown>,
  };
};

const pendingForGuest = () =>
  listWhatsAppOwnMessageHistory({ accountId: "default", peerE164: GUEST });

describe("processMessage with own messages", () => {
  beforeEach(async () => {
    for (const entries of mocks.namespaces.values()) {
      entries.clear();
    }
    mocks.prepared.mockClear();
    mocks.resolvePolicy.mockReturnValue(policy({ ownMessages: "history" }));
    await recordWhatsAppOwnMessageHistory({
      accountId: "default",
      messageId: "own-1",
      chatJid: GUEST_JID,
      peerE164: GUEST,
      timestampMs: 1_760_000_000_000,
      text: "The pool is cleaned on Mondays.",
    });
  });

  it("puts the business's own messages into the guest's next turn and consumes them", async () => {
    await runTurn(directMessage({ peer: GUEST, id: "guest-1", body: "When is the pool cleaned?" }));

    const { params, ctx } = preparedCall();
    expect(params.directHistory).toEqual([
      expect.objectContaining({
        sender: "(self)",
        body: "The pool is cleaned on Mondays.",
        id: "own-1",
      }),
    ]);
    // The business's message reads as the core writes a message the account sent: (self).
    expect(params.combinedBody).toMatch(
      new RegExp(`\\[WhatsApp \\${GUEST}[^\\]]*\\] \\(self\\): The pool is cleaned on Mondays\\.`),
    );
    expect(params.combinedBody).toContain("When is the pool cleaned?");
    expect(ctx.InboundEventKind).toBe("user_request");
    // Same window as sessionTranscript historyKind "recent", so the same framing.
    expect(params.combinedBody).toContain("[Recent chat messages - for context]");
    expect(ctx.InboundHistory).toEqual([
      expect.objectContaining({
        sender: "(self)",
        body: "The pool is cleaned on Mondays.",
      }),
    ]);
    expect(ctx.SessionTranscriptContext).toEqual(
      expect.objectContaining({ historyLimit: 1, historyKind: "recent" }),
    );
    await expect(pendingForGuest()).resolves.toEqual([]);
  });

  it("shows the newest historyLimit messages and consumes the older ones too", async () => {
    for (const [messageId, timestampMs] of [
      ["own-2", 1_760_000_001_000],
      ["own-3", 1_760_000_002_000],
    ] as const) {
      await recordWhatsAppOwnMessageHistory({
        accountId: "default",
        messageId,
        chatJid: GUEST_JID,
        peerE164: GUEST,
        timestampMs,
        text: `Message ${messageId}`,
      });
    }

    await runTurn(directMessage({ peer: GUEST, id: "guest-1", body: "Thanks" }), {
      historyLimit: 2,
    });

    expect(
      preparedCall().params.directHistory?.map((entry) => (entry as { id: string }).id),
    ).toEqual(["own-2", "own-3"]);
    await expect(pendingForGuest()).resolves.toEqual([]);
  });

  it("keeps the history when the turn is not dispatched", async () => {
    const failure = new Error("dispatch failed");

    await expect(
      runTurn(directMessage({ peer: GUEST, id: "guest-1", body: "Hello?" }), {
        dispatchReplyFromConfig: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    await expect(pendingForGuest()).resolves.toHaveLength(1);
  });

  it("shows only the assistant's sends with ownMessages off, and consumes the phone's too", async () => {
    mocks.resolvePolicy.mockReturnValue(policy({}));
    await recordWhatsAppAssistantMessageHistory({
      accountId: "default",
      messageId: "wa-1",
      peerE164: GUEST,
      timestampMs: 1_760_000_001_000,
      text: "Your late checkout is approved.",
    });

    await runTurn(directMessage({ peer: GUEST, id: "guest-1", body: "Thank you!" }));

    const { params } = preparedCall();
    expect(params.directHistory).toEqual([
      expect.objectContaining({
        sender: "(self)",
        body: "[sent by the assistant from another chat] Your late checkout is approved.",
        id: "wa-1",
      }),
    ]);
    expect(params.combinedBody).toMatch(
      /\(self\): \[sent by the assistant from another chat\] Your late checkout is approved\./,
    );
    await expect(pendingForGuest()).resolves.toEqual([]);
  });

  it("marks the owner turn for hooks, keeps it unquoted, and leaves the guest history alone", async () => {
    mocks.resolvePolicy.mockReturnValue(policy({ ownMessages: "turn", replyToMode: "all" }));
    const ownMessage = { messageId: "own-1", peerE164: GUEST, timestampMs: 1_760_000_000_000 };

    await runTurn(
      directMessage({
        peer: OWNER,
        body: `[WhatsApp ${GUEST}] (self): The pool is cleaned on Mondays.`,
        ownMessage,
      }),
    );

    const { params, ctx } = preparedCall();
    // One envelope, from the guest's chat; the owner chat adds no second one.
    expect(params.combinedBody).toBe(`[WhatsApp ${GUEST}] (self): The pool is cleaned on Mondays.`);
    expect(ctx.ChannelContext).toEqual({ chat: { ownMessage } });
    // The owner said it to somebody else: the agent observes it, nobody asked it.
    expect(ctx.InboundEventKind).toBe("room_event");
    expect(ctx.SenderE164).toBe(OWNER);
    expect(params.directHistory).toBeUndefined();
    expect(params.replyThreading).toEqual(
      expect.objectContaining({ implicitCurrentMessage: "deny" }),
    );
    await expect(pendingForGuest()).resolves.toHaveLength(1);
  });

  it("leaves an entry stored while a turn runs to the next turn", async () => {
    // after_tool_call stores an agent send without core awaiting it, so the entry can land
    // while the recipient's turn is already running; that turn must not consume it.
    await runTurn(directMessage({ peer: GUEST, id: "guest-1", body: "Hello?" }), {
      dispatchReplyFromConfig: async () => {
        await recordWhatsAppAssistantMessageHistory({
          accountId: "default",
          messageId: "wa-late",
          peerE164: GUEST,
          timestampMs: 1_760_000_002_000,
          text: "Your late checkout is approved.",
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });

    await expect(pendingForGuest()).resolves.toEqual([
      expect.objectContaining({ message: expect.objectContaining({ messageId: "wa-late" }) }),
    ]);
  });
});
