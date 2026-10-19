import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

const mocks = vi.hoisted(() => ({
  resolvePolicy: vi.fn(),
  prepared: vi.fn(),
  replyPlan: vi.fn(),
  appendTranscript: vi.fn(async () => ({ kind: "result" as const })),
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
      ...(mocks.replyPlan(params) as object),
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

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => ({
    session: { dmScope: "per-account-channel-peer" },
    channels: { whatsapp: {} },
  }),
}));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>()),
  appendSessionTranscriptMessageByIdentityStrict: mocks.appendTranscript,
}));

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
  readWhatsAppOverdueAnswer,
  recordWhatsAppAnswer,
  recordWhatsAppTurnSend,
  recordWhatsAppUnansweredMessage,
} from "../../overdue-answers.js";
import {
  recordWhatsAppAssistantMessageHistory,
  recordWhatsAppOwnMessageHistory,
} from "../../own-message-history.js";
import { processMessage } from "./process-message.js";

const SELF = "+15550000100";
const OWNER = "+15550000200";
const CONTACT = "+15550000300";
const CONTACT_JID = "15550000300@s.whatsapp.net";

function policy(account: Record<string, unknown>) {
  return {
    account: { accountId: "default", authDir: "/tmp/wa-test-auth", ...account },
    dmPolicy: "allowlist",
    groupPolicy: "disabled",
    configuredAllowFrom: [OWNER, CONTACT],
    dmAllowFrom: [OWNER, CONTACT],
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
    cfg?: Record<string, unknown>;
  } = {},
) {
  const backgroundTasks = new Set<Promise<unknown>>();
  const peer = msg.admission.conversation.id;
  const turn = processMessage({
    cfg: (options.cfg ?? {}) as never,
    msg: msg as never,
    route: {
      agentId: "assistant",
      channel: "whatsapp",
      accountId: "default",
      sessionKey: `agent:assistant:whatsapp:direct:${peer}`,
      mainSessionKey: "agent:assistant:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    } as never,
    groupHistoryKey: `agent:assistant:whatsapp:direct:${peer}`,
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

describe("processMessage with own messages", () => {
  beforeEach(() => {
    for (const entries of mocks.namespaces.values()) {
      entries.clear();
    }
    mocks.prepared.mockClear();
    mocks.appendTranscript.mockClear();
    mocks.resolvePolicy.mockReturnValue(policy({}));
  });

  it("keeps canonical own messages out of duplicate next-turn context", async () => {
    await recordWhatsAppOwnMessageHistory({
      accountId: "default",
      messageId: "own-1",
      chatJid: CONTACT_JID,
      peerE164: CONTACT,
      timestampMs: 1_760_000_000_000,
      text: "The report is ready on Mondays.",
    });
    await runTurn(
      directMessage({ peer: CONTACT, id: "contact-1", body: "When is the report ready?" }),
    );

    const { params, ctx } = preparedCall();
    expect(params.directHistory).toBeUndefined();
    expect(params.combinedBody).toContain("When is the report ready?");
    expect(params.combinedBody).not.toContain("The report is ready on Mondays.");
    expect(ctx.InboundEventKind).toBe("user_request");
    expect(ctx.InboundHistory).toBeUndefined();
  });

  it("keeps assistant sends out of the next contact message body", async () => {
    await recordWhatsAppAssistantMessageHistory({
      accountId: "default",
      messageId: "wa-1",
      peerE164: CONTACT,
      timestampMs: 1_760_000_001_000,
      text: "Your order A-100 has shipped.",
    });

    await runTurn(directMessage({ peer: CONTACT, id: "contact-1", body: "Thank you!" }));

    const { params } = preparedCall();
    expect(params.directHistory).toBeUndefined();
    expect(params.combinedBody).toContain("Thank you!");
    expect(params.combinedBody).not.toContain("Your order A-100 has shipped.");
  });

  it("marks the owner turn for hooks, keeps it unquoted, and leaves the contact history alone", async () => {
    mocks.resolvePolicy.mockReturnValue(policy({ replyToMode: "all" }));
    const ownMessage = { messageId: "own-1", peerE164: CONTACT, timestampMs: 1_760_000_000_000 };

    await runTurn(
      directMessage({
        peer: OWNER,
        body: `[WhatsApp ${CONTACT}] (self): The report is ready on Mondays.`,
        ownMessage,
      }),
    );

    const { params, ctx } = preparedCall();
    // One envelope, from the contact's chat; the owner chat adds no second one.
    expect(params.combinedBody).toBe(
      `[WhatsApp ${CONTACT}] (self): The report is ready on Mondays.`,
    );
    expect(ctx.ChannelContext).toEqual(
      expect.objectContaining({
        chat: {
          ownMessage,
          receivedText: `[WhatsApp ${CONTACT}] (self): The report is ready on Mondays.`,
        },
      }),
    );
    // The owner said it to somebody else: the agent observes it, nobody asked it.
    expect(ctx.InboundEventKind).toBe("room_event");
    expect(ctx.SenderE164).toBe(OWNER);
    expect(params.directHistory).toBeUndefined();
    expect(params.replyThreading).toEqual(
      expect.objectContaining({ implicitCurrentMessage: "deny" }),
    );
  });

  it("leaves an entry stored while a turn runs to the next turn", async () => {
    // after_tool_call stores an agent send without core awaiting it, so the entry can land
    // while the recipient's turn is already running; that turn must not consume it.
    await runTurn(directMessage({ peer: CONTACT, id: "contact-1", body: "Hello?" }), {
      dispatchReplyFromConfig: async () => {
        await recordWhatsAppAssistantMessageHistory({
          accountId: "default",
          messageId: "wa-late",
          peerE164: CONTACT,
          timestampMs: 1_760_000_002_000,
          text: "Your order A-100 has shipped.",
        });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });
  });
});

describe("processMessage while the answer is overdue", () => {
  const EARLIEST_SENT_AT_MS = Date.UTC(2026, 9, 16, 14, 0, 0);
  const overdueMessage = () => ({
    ...directMessage({ peer: CONTACT, id: "contact-overdue", body: "Is my order ready?" }),
    overdueAnswer: { earliestSentAtMs: EARLIEST_SENT_AT_MS },
  });
  const replyPlanParams = () =>
    mocks.replyPlan.mock.calls.at(-1)?.[0] as {
      overdueAnswer?: unknown;
      readOverdueAnswer?: () => Promise<unknown>;
    };

  beforeEach(() => {
    for (const entries of mocks.namespaces.values()) {
      entries.clear();
    }
    mocks.prepared.mockClear();
    mocks.replyPlan.mockClear();
    mocks.resolvePolicy.mockReturnValue(policy({}));
  });

  it("tells the turn the answer is overdue and gives the reply plan the verdict", async () => {
    await runTurn(overdueMessage());

    expect(preparedCall().ctx.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        label: "WhatsApp overdue answer",
        type: "overdue_answer",
        payload: expect.objectContaining({
          earliest_unanswered_message_sent_at: "2026-10-16T14:00:00.000Z",
          can_write_to: "owner",
        }),
      }),
    ]);
    expect(replyPlanParams().overdueAnswer).toEqual({ earliestSentAtMs: EARLIEST_SENT_AT_MS });
  });

  it("lets the reply plan read the person's overdue answer as each reply leaves", async () => {
    await runTurn(directMessage({ peer: CONTACT, id: "contact-1", body: "Status?" }));
    const { readOverdueAnswer } = replyPlanParams();
    const person = { accountId: "default", personE164: CONTACT };

    await expect(readOverdueAnswer?.()).resolves.toBeUndefined();
    await recordWhatsAppUnansweredMessage(person, {
      sentAtMs: Date.now() - 16 * 60_000,
      receivedAtMs: Date.now(),
    });
    await expect(readOverdueAnswer?.()).resolves.toEqual({
      earliestSentAtMs: expect.any(Number),
    });
    await recordWhatsAppAnswer(person, Date.now());
    await expect(readOverdueAnswer?.()).resolves.toBeUndefined();
  });

  it("gives an ordinary turn no overdue fact and leaves message injection to core", async () => {
    let replyOptions: Record<string, unknown> | undefined;
    await runTurn(directMessage({ peer: CONTACT, id: "contact-2", body: "Status?" }), {
      dispatchReplyFromConfig: async (params) => {
        replyOptions = params.replyOptions as Record<string, unknown>;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    });

    expect(preparedCall().ctx.ChannelStructuredContext).toBeUndefined();
    expect(replyPlanParams().overdueAnswer).toBeUndefined();
    expect(replyOptions?.messageInjectionDisposition).toBeUndefined();
  });

  describe("the end of a turn", () => {
    const person = { accountId: "default", personE164: CONTACT };
    const sentMinutesAgo = (id: string, minutes: number) => {
      const message = directMessage({ peer: CONTACT, id, body: "👍" });
      return { ...message, event: { ...message.event, timestamp: Date.now() - minutes * 60_000 } };
    };
    const receive = (message: { event: { id?: string; timestamp?: number } }) =>
      recordWhatsAppUnansweredMessage(person, {
        ...(message.event.id ? { id: message.event.id } : {}),
        ...(message.event.timestamp !== undefined ? { sentAtMs: message.event.timestamp } : {}),
        receivedAtMs: Date.now(),
      });
    const overdueIn = async (minutes: number) =>
      readWhatsAppOverdueAnswer(person, Date.now() + minutes * 60_000);

    it("handles a message the agent read and chose not to answer", async () => {
      const thumbsUp = sentMinutesAgo("thumbs-up", 1);
      await receive(thumbsUp);

      await runTurn(thumbsUp);

      await expect(overdueIn(30)).resolves.toBeUndefined();
    });

    it("keeps a message waiting when the turn handed it to the owner", async () => {
      const breakdown = sentMinutesAgo("breakdown", 1);
      await receive(breakdown);

      await runTurn(breakdown, {
        dispatchReplyFromConfig: async () => {
          recordWhatsAppTurnSend(`agent:assistant:whatsapp:direct:${CONTACT}`);
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      });

      await expect(overdueIn(30)).resolves.toEqual({ earliestSentAtMs: breakdown.event.timestamp });
    });

    it("handles a message that joined the running turn when that turn ends", async () => {
      const question = sentMinutesAgo("question", 2);
      const thanks = sentMinutesAgo("thanks", 1);
      await receive(question);
      await receive(thanks);
      const steered = async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        deferredToActiveRun: "steer" as const,
      });

      await runTurn(thanks, { dispatchReplyFromConfig: steered });
      await expect(overdueIn(30)).resolves.toEqual({ earliestSentAtMs: question.event.timestamp });

      await runTurn(question);
      await expect(overdueIn(30)).resolves.toBeUndefined();
    });

    it("leaves a message queued as a follow-up to its own turn", async () => {
      const followUp = sentMinutesAgo("follow-up", 1);
      await receive(followUp);

      await runTurn(followUp, {
        dispatchReplyFromConfig: async () => ({
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
          deferredToActiveRun: "followup" as const,
        }),
      });

      await expect(overdueIn(30)).resolves.toEqual({ earliestSentAtMs: followUp.event.timestamp });
    });

    it("handles nothing for a turn that started overdue: the owner decides", async () => {
      const late = sentMinutesAgo("late", 20);
      await receive(late);

      await runTurn({ ...late, overdueAnswer: { earliestSentAtMs: late.event.timestamp } });

      await expect(overdueIn(0)).resolves.toEqual({ earliestSentAtMs: late.event.timestamp });
    });
  });

  it("never reads an overdue answer for the owner's chat", async () => {
    await runTurn(directMessage({ peer: OWNER, id: "owner-1", body: "Status?" }), {
      cfg: { commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] } },
    });

    expect(replyPlanParams().readOverdueAnswer).toBeUndefined();
  });
});
