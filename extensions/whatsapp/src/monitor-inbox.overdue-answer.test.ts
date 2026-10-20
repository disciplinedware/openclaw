// Every arrival path records a person's message by its send time; a turn that starts while the
// person's answer is overdue carries the fact and leaves the messages unread. Only a message
// delivered to the person (the plugin's send or the phone's own message) answers it.
import { describe, expect, it, vi } from "vitest";
import { serializeWhatsAppDurableInboundMessage } from "./inbound/durable-payload.js";
import {
  createWhatsAppDurableInboundMessageId,
  createWhatsAppDurableInboundQueue,
  type WhatsAppDurableInboundQueue,
} from "./inbound/durable-receive.js";
import type { WebInboundCallbackMessage } from "./inbound/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  waitForInboundWorkDrained,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";
import { readWhatsAppOverdueAnswer, readWhatsAppUnansweredMessages } from "./overdue-answers.js";

const CONTACT_JID = "15550000300@s.whatsapp.net";
const OWNER_JID = "15550000200@s.whatsapp.net";
const OWNER = "+15550000200";
const GROUP_JID = "120363@g.us";
const MINUTE_MS = 60_000;

type Sock = Awaited<ReturnType<typeof startInboxMonitor>>["sock"];
type Missed = {
  id: string;
  remoteJid: string;
  sentAtMs?: number;
  participant?: string;
  fromMe?: boolean;
};

function emit(sock: Sock, type: "append" | "notify", messages: Missed[]) {
  sock.ev.emit("messages.upsert", {
    type,
    messages: messages.map((message) => ({
      key: {
        id: message.id,
        fromMe: message.fromMe === true,
        remoteJid: message.remoteJid,
        ...(message.participant ? { participant: message.participant } : {}),
      },
      message: { conversation: `text of ${message.id}` },
      ...(message.sentAtMs !== undefined
        ? { messageTimestamp: Math.floor(message.sentAtMs / 1000) }
        : {}),
      pushName: "Alex",
    })),
  });
}

const minutesAgo = (minutes: number) => Date.now() - minutes * MINUTE_MS;
/** A send time as WhatsApp carries it: whole seconds. */
const toWireMs = (sentAtMs: number) => Math.floor(sentAtMs / 1000) * 1000;

/** A turn callback that records each turn's overdue fact, keyed by its last message id. */
function recordTurns() {
  const turns: Array<{ id: string | undefined; body: string; overdueAnswer: unknown }> = [];
  const onMessage = vi.fn(async (msg: WebInboundCallbackMessage) => {
    turns.push({ id: msg.event.id, body: msg.payload.body, overdueAnswer: msg.overdueAnswer });
  });
  return { onMessage, turns };
}

const CONTACT = { accountId: DEFAULT_ACCOUNT_ID, personE164: "+15550000300" };
const readContactOverdue = () => readWhatsAppOverdueAnswer(CONTACT, Date.now());

const readIds = (sock: Sock) =>
  sock.readMessages.mock.calls.flatMap(([keys]: [Array<{ id?: string }>]) =>
    keys.map((key) => key.id),
  );

/** Persists a durable row as an earlier gateway wrote it, before a restart. */
async function persistRow(
  queue: WhatsAppDurableInboundQueue,
  params: { id: string; sentAtMs: number; row: Record<string, unknown> },
) {
  const message = {
    key: { id: params.id, fromMe: false, remoteJid: CONTACT_JID },
    message: { conversation: `text of ${params.id}` },
    messageTimestamp: Math.floor(params.sentAtMs / 1000),
    pushName: "Alex",
  };
  await queue.enqueue(
    createWhatsAppDurableInboundMessageId({ remoteJid: CONTACT_JID, id: params.id }),
    {
      message: serializeWhatsAppDurableInboundMessage(message),
      receivedAt: Date.now(),
      ...params.row,
    } as Parameters<WhatsAppDurableInboundQueue["enqueue"]>[1],
    { laneKey: CONTACT_JID },
  );
}

describe("overdue answers of direct chats", () => {
  installWebMonitorInboxUnitTestHooks();

  it.each([5, 14])(
    "gives a message sent %i minutes ago an ordinary turn and a read receipt",
    async (minutes) => {
      const { onMessage, turns } = recordTurns();
      const { listener, sock } = await startInboxMonitor(onMessage);

      emit(sock, "append", [{ id: "m", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(minutes) }]);
      await waitForMessageCalls(onMessage, 1);
      await waitForInboundWorkDrained();

      expect(turns).toEqual([expect.objectContaining({ id: "m", overdueAnswer: undefined })]);
      expect(readIds(sock)).toEqual(["m"]);
      await listener.close();
    },
  );

  it.each([16, 20])(
    "gives a message sent %i minutes ago an overdue turn and no read receipt",
    async (minutes) => {
      const { onMessage, turns } = recordTurns();
      const { listener, sock } = await startInboxMonitor(onMessage);
      const sentAtMs = minutesAgo(minutes);

      emit(sock, "append", [{ id: "m", remoteJid: CONTACT_JID, sentAtMs }]);
      await waitForMessageCalls(onMessage, 1);
      await waitForInboundWorkDrained();

      expect(turns).toEqual([
        expect.objectContaining({
          id: "m",
          overdueAnswer: { earliestSentAtMs: toWireMs(sentAtMs) },
        }),
      ]);
      expect(readIds(sock)).toEqual([]);
      await expect(readContactOverdue()).resolves.toEqual({ earliestSentAtMs: toWireMs(sentAtMs) });
      await listener.close();
    },
  );

  it("records a message of the in-process reconnect window by its send time", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyWindow: {
        afterMs: Date.now() - 30 * MINUTE_MS,
        untilMs: Date.now() + 30 * MINUTE_MS,
        maxAgeMs: 20 * MINUTE_MS,
      },
    });
    const sentAtMs = minutesAgo(16);

    emit(sock, "append", [{ id: "m16", remoteJid: CONTACT_JID, sentAtMs }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([
      expect.objectContaining({
        id: "m16",
        overdueAnswer: { earliestSentAtMs: toWireMs(sentAtMs) },
      }),
    ]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("records a live message by its send time too", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "notify", [{ id: "slow", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(16) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([
      expect.objectContaining({ id: "slow", overdueAnswer: expect.any(Object) }),
    ]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("counts a message without a send time as overdue", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "notify", [{ id: "no-time", remoteJid: CONTACT_JID }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([expect.objectContaining({ id: "no-time", overdueAnswer: {} })]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("makes one turn of a 20 and a 14 minute old message overdue, by the earlier one", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage, { debounceMs: 50 });
    const earliest = minutesAgo(20);

    emit(sock, "append", [
      { id: "m14", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(14) },
      { id: "m20", remoteJid: CONTACT_JID, sentAtMs: earliest },
    ]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([
      {
        id: "m14",
        body: "text of m20\ntext of m14",
        overdueAnswer: { earliestSentAtMs: toWireMs(earliest) },
      },
    ]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("keeps the newer message's separate turn overdue: the earlier message still waits", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage, { debounceMs: 0 });
    const earliest = minutesAgo(20);

    emit(sock, "append", [
      { id: "m20", remoteJid: CONTACT_JID, sentAtMs: earliest },
      { id: "m14", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(14) },
    ]);
    await waitForMessageCalls(onMessage, 2);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([
      expect.objectContaining({
        id: "m20",
        overdueAnswer: { earliestSentAtMs: toWireMs(earliest) },
      }),
      expect.objectContaining({
        id: "m14",
        overdueAnswer: { earliestSentAtMs: toWireMs(earliest) },
      }),
    ]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("keeps the person overdue when they write again live, without a read receipt", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "append", [{ id: "m20", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    emit(sock, "notify", [{ id: "live", remoteJid: CONTACT_JID, sentAtMs: Date.now() }]);
    await waitForMessageCalls(onMessage, 2);
    await waitForInboundWorkDrained();

    expect(turns.map((turn) => [turn.id, turn.overdueAnswer !== undefined])).toEqual([
      ["m20", true],
      ["live", true],
    ]);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("ends with the phone's own message to the person, and a later message starts a new clock", async () => {
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "append", [{ id: "m20", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    emit(sock, "notify", [
      { id: "phone", remoteJid: CONTACT_JID, sentAtMs: Date.now(), fromMe: true },
    ]);
    await waitForInboundWorkDrained();
    await expect(readContactOverdue()).resolves.toBeUndefined();

    emit(sock, "notify", [{ id: "next", remoteJid: CONTACT_JID, sentAtMs: Date.now() + 1_000 }]);
    await waitForMessageCalls(onMessage, 2);
    await waitForInboundWorkDrained();

    expect(turns.map((turn) => [turn.id, turn.overdueAnswer !== undefined])).toEqual([
      ["m20", true],
      ["next", false],
    ]);
    expect(readIds(sock)).toEqual(["next"]);
    await listener.close();
  });

  it("delivers a send to an overdue person and ends the overdue answer with it", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);
    // Baileys resolves a send with the message it built, its content included.
    sock.sendMessage.mockImplementation(async (_jid: string, content: { text?: string }) => ({
      key: { id: "sent-1", fromMe: true },
      message: { conversation: content.text },
    }));

    emit(sock, "append", [{ id: "m20", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    await expect(readContactOverdue()).resolves.toBeDefined();

    // The send guard decided at the call; the transport delivers whenever the call proceeds.
    await listener.sendMessage(CONTACT.personE164, "Your order is ready.");

    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    await expect(readContactOverdue()).resolves.toBeUndefined();
    await listener.close();
  });

  it("keeps the person's messages with their text until a delivered send answers them", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);
    sock.sendMessage.mockImplementation(async (_jid: string, content: { text?: string }) => ({
      key: { id: "sent-1", fromMe: true },
      message: { conversation: content.text },
    }));
    const firstAtMs = minutesAgo(2);
    const secondAtMs = minutesAgo(1);

    emit(sock, "notify", [{ id: "first", remoteJid: CONTACT_JID, sentAtMs: firstAtMs }]);
    emit(sock, "notify", [{ id: "second", remoteJid: CONTACT_JID, sentAtMs: secondAtMs }]);
    await waitForMessageCalls(onMessage, 2);
    await waitForInboundWorkDrained();
    await expect(readWhatsAppUnansweredMessages(CONTACT)).resolves.toEqual([
      expect.objectContaining({
        id: "first",
        sentAtMs: toWireMs(firstAtMs),
        text: "text of first",
      }),
      expect.objectContaining({
        id: "second",
        sentAtMs: toWireMs(secondAtMs),
        text: "text of second",
      }),
    ]);

    await listener.sendMessage(CONTACT.personE164, "Both answered.");

    await expect(readWhatsAppUnansweredMessages(CONTACT)).resolves.toEqual([]);
    await listener.close();
  });

  it("ends the overdue answer of a person written to under another form of the number", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);
    // WhatsApp registers this Mexican mobile as 521…; systems of record store it as +52….
    const registeredJid = "5215500000000@s.whatsapp.net";
    const person = { accountId: DEFAULT_ACCOUNT_ID, personE164: "+5215500000000" };
    sock.onWhatsApp.mockResolvedValue([{ jid: registeredJid, exists: true }]);
    sock.sendMessage.mockImplementation(async (jid: string, content: { text?: string }) => ({
      key: { id: "sent-mx", fromMe: true, remoteJid: jid },
      message: { conversation: content.text },
    }));

    emit(sock, "append", [{ id: "mx20", remoteJid: registeredJid, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    await expect(readWhatsAppOverdueAnswer(person, Date.now())).resolves.toBeDefined();

    await listener.sendMessage("+525500000000", "Hola");

    expect(sock.sendMessage).toHaveBeenCalledWith(registeredJid, { text: "Hola" });
    await expect(readWhatsAppOverdueAnswer(person, Date.now())).resolves.toBeUndefined();
    await listener.close();
  });

  it("does not count a reaction to the person as an answer", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);
    sock.sendMessage.mockImplementation(async () => ({
      key: { id: "react-1", fromMe: true },
      message: { reactionMessage: { text: "👍", key: { id: "m20" } } },
    }));

    emit(sock, "append", [{ id: "m20", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    await listener.sendReaction(CONTACT_JID, "m20", "👍", false);

    await expect(readContactOverdue()).resolves.toBeDefined();
    await listener.close();
  });

  it.each([
    { name: "previous_build_row", row: { version: 2, upsertType: "notify", staleAppend: false } },
    { name: "stock_row", row: { upsertType: "notify", skipStaleAppend: false } },
  ])(
    "records a durable row replayed after a long downtime by its send time ($name)",
    async ({ row }) => {
      const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
      const sentAtMs = minutesAgo(180);
      await persistRow(queue, { id: "stored", sentAtMs, row });
      const { onMessage, turns } = recordTurns();

      const { listener, sock } = await startInboxMonitor(onMessage, { durableInboundQueue: queue });
      await waitForMessageCalls(onMessage, 1);
      await waitForInboundWorkDrained();

      expect(turns).toEqual([
        expect.objectContaining({
          id: "stored",
          overdueAnswer: { earliestSentAtMs: toWireMs(sentAtMs) },
        }),
      ]);
      expect(readIds(sock)).toEqual([]);
      await listener.close();
    },
  );

  it("replays a durable row of a message sent a minute ago as an ordinary turn", async () => {
    const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
    await persistRow(queue, {
      id: "fresh",
      sentAtMs: minutesAgo(1),
      row: { version: 2, upsertType: "append", staleAppend: true, lateChat: {} },
    });
    const { onMessage, turns } = recordTurns();

    const { listener, sock } = await startInboxMonitor(onMessage, { durableInboundQueue: queue });
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([expect.objectContaining({ id: "fresh", overdueAnswer: undefined })]);
    expect(readIds(sock)).toEqual(["fresh"]);
    await listener.close();
  });

  it("leaves an overdue message unread on redelivery", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);
    const missed = { id: "m20", remoteJid: CONTACT_JID, sentAtMs: minutesAgo(20) };

    emit(sock, "append", [missed]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();
    emit(sock, "append", [missed]);
    await waitForInboundWorkDrained();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(readIds(sock)).toEqual([]);
    await listener.close();
  });

  it("never makes a command owner's answer overdue", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] },
    });
    const { onMessage, turns } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "append", [{ id: "owner20", remoteJid: OWNER_JID, sentAtMs: minutesAgo(20) }]);
    await waitForMessageCalls(onMessage, 1);
    await waitForInboundWorkDrained();

    expect(turns).toEqual([expect.objectContaining({ id: "owner20", overdueAnswer: undefined })]);
    expect(readIds(sock)).toEqual(["owner20"]);
    await listener.close();
  });

  it("skips group backfill without a read receipt", async () => {
    const { onMessage } = recordTurns();
    const { listener, sock } = await startInboxMonitor(onMessage);

    emit(sock, "append", [
      { id: "group20", remoteJid: GROUP_JID, sentAtMs: minutesAgo(20), participant: CONTACT_JID },
    ]);
    await waitForInboundWorkDrained();

    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.readMessages).not.toHaveBeenCalled();
    await listener.close();
  });
});
