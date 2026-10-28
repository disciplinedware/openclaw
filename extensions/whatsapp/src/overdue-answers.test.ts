// A person's answer is overdue while their earliest message that nothing handled is more than
// 15 minutes old: a message delivered to them from the business number handles it, and so does a
// turn of theirs that sent nothing and ended before then.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listWhatsAppOverdueAnswers,
  readWhatsAppOverdueAnswer,
  readWhatsAppUnansweredMessages,
  recordWhatsAppAnswer,
  recordWhatsAppMessageSteered,
  recordWhatsAppTurnEnded,
  recordWhatsAppUnansweredMessage,
} from "./overdue-answers.js";

const runtimes = vi.hoisted(() => ({
  current: undefined as unknown,
  restart: (() => {}) as () => void,
}));
const runtimeConfig = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),

  getRuntimeConfig: () => runtimeConfig.current,
}));

vi.mock("./runtime.js", async (importOriginal) => {
  const { createMemoryPluginStateRuntime } = await import("./plugin-state.test-helper.js");
  const state = createMemoryPluginStateRuntime();
  runtimes.current = state.runtime;
  // A new runtime object over the same storage, as after a gateway restart: every store reopens.
  runtimes.restart = () => {
    runtimes.current = { ...state.runtime, state: { ...state.runtime.state } };
  };
  return {
    ...(await importOriginal<typeof import("./runtime.js")>()),
    getWhatsAppRuntime: () => runtimes.current,
    getOptionalWhatsAppRuntime: () => runtimes.current,
  };
});

const MINUTE_MS = 60_000;
const OVERDUE_THRESHOLD_MS = 15 * MINUTE_MS;
const NOW_MS = Date.UTC(2026, 9, 17, 12, 0, 0);
const minutesBefore = (minutes: number) => NOW_MS - minutes * MINUTE_MS;

let personCounter = 0;
let contact = { accountId: "default", personE164: "+15550000300" };

beforeEach(() => {
  personCounter += 1;
  contact = {
    accountId: "default",
    personE164: `+1555000${String(personCounter).padStart(4, "0")}`,
  };
  runtimeConfig.current = {};
});

const receive = (sentAtMs: number | undefined, id?: string) =>
  recordWhatsAppUnansweredMessage(contact, {
    ...(id ? { id } : {}),
    ...(sentAtMs !== undefined ? { sentAtMs } : {}),
    receivedAtMs: NOW_MS,
  });

const silentTurn = (sentAtMs: number) => ({ sentAtMs, sent: false });

describe("overdue answers", () => {
  it.each([
    { name: "five_minutes", minutes: 5, overdue: false },
    {
      name: "exactly_at_threshold",
      minutes: OVERDUE_THRESHOLD_MS / MINUTE_MS,
      overdue: false,
    },
    { name: "sixteen_minutes", minutes: 16, overdue: true },
    { name: "twenty_minutes", minutes: 20, overdue: true },
  ])("decides a message sent $minutes minutes ago ($name)", async ({ minutes, overdue }) => {
    await receive(minutesBefore(minutes));

    const result = await readWhatsAppOverdueAnswer(contact, NOW_MS);

    expect(result).toEqual(overdue ? { earliestSentAtMs: minutesBefore(minutes) } : undefined);
  });

  it("counts a message without a send time as overdue", async () => {
    await receive(minutesBefore(1));
    await receive(undefined);

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(1),
    });
  });

  it("names the earliest unanswered message whatever order the messages arrive in", async () => {
    await receive(minutesBefore(14), "m14");
    await receive(minutesBefore(20), "m20");

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });

  it("keeps the person overdue when they write again: the earlier message still waits", async () => {
    await receive(minutesBefore(20), "m20");
    await receive(NOW_MS, "live");

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });

  it("ends with an answer, and a later message starts a new clock", async () => {
    await receive(minutesBefore(20), "m20");
    await recordWhatsAppAnswer(contact, minutesBefore(2));

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();

    await receive(minutesBefore(1), "next");
    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();
    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS + 15 * MINUTE_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(1),
    });
  });

  it("answers only the messages sent before the answer, in any arrival order", async () => {
    await receive(minutesBefore(30), "before");
    await receive(minutesBefore(20), "after");
    await recordWhatsAppAnswer(contact, minutesBefore(25));

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });

  it("handles a message the agent read and chose not to answer when its turn ends", async () => {
    await receive(minutesBefore(14), "thumbs-up");
    await recordWhatsAppTurnEnded(contact, silentTurn(minutesBefore(14)), minutesBefore(13));

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();
  });

  it("keeps a message waiting when its turn sent something: a handoff to the owner", async () => {
    await receive(minutesBefore(20), "breakdown");
    await recordWhatsAppTurnEnded(
      contact,
      { sentAtMs: minutesBefore(20), sent: true },
      minutesBefore(19),
    );

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });

  it("handles a message that joined the running turn when that turn ends", async () => {
    await receive(minutesBefore(14), "question");
    await receive(minutesBefore(13), "thanks");
    recordWhatsAppMessageSteered(contact, minutesBefore(13));
    await recordWhatsAppTurnEnded(contact, silentTurn(minutesBefore(14)), minutesBefore(12));

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();
  });

  it("keeps the turn's messages waiting while a newer message waits: its turn answers them all", async () => {
    await receive(minutesBefore(20), "question");
    await receive(minutesBefore(19), "follow-up");
    await recordWhatsAppTurnEnded(contact, silentTurn(minutesBefore(20)), minutesBefore(18));

    await expect(readWhatsAppUnansweredMessages(contact)).resolves.toEqual([
      expect.objectContaining({ sentAtMs: minutesBefore(20) }),
      expect.objectContaining({ sentAtMs: minutesBefore(19) }),
    ]);
  });

  it("handles nothing when the turn ends after the answer became overdue: the owner decides", async () => {
    await receive(minutesBefore(20), "question");
    await recordWhatsAppTurnEnded(contact, silentTurn(minutesBefore(20)), NOW_MS);

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });

  it("ignores a message an earlier answer already answered, delivered again after it", async () => {
    await recordWhatsAppAnswer(contact, minutesBefore(5));
    await receive(minutesBefore(30), "old");

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();
  });

  it("keeps one person's state apart from the same number on another account", async () => {
    await receive(minutesBefore(20));

    await expect(
      readWhatsAppOverdueAnswer({ ...contact, accountId: "second" }, NOW_MS),
    ).resolves.toBeUndefined();
    await expect(listWhatsAppOverdueAnswers(NOW_MS)).resolves.toContainEqual({
      ...contact,
      overdue: { earliestSentAtMs: minutesBefore(20) },
    });
  });

  it("hides overdue state while disabled without stopping state collection", async () => {
    await receive(minutesBefore(20));
    runtimeConfig.current = {
      plugins: {
        entries: { "whatsapp-for-business": { config: { blockOverdueAnswers: false } } },
      },
    };

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toBeUndefined();
    await expect(listWhatsAppOverdueAnswers(NOW_MS)).resolves.toEqual([]);

    runtimeConfig.current = {};
    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
    await expect(listWhatsAppOverdueAnswers(NOW_MS)).resolves.toContainEqual({
      ...contact,
      overdue: { earliestSentAtMs: minutesBefore(20) },
    });
  });

  it("serializes concurrent writes of one person", async () => {
    await Promise.all([
      receive(minutesBefore(20), "a"),
      receive(minutesBefore(19), "b"),
      recordWhatsAppAnswer(contact, minutesBefore(19.5)),
    ]);

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(19),
    });
  });

  it("survives a restart", async () => {
    await receive(minutesBefore(20));

    runtimes.restart();

    await expect(readWhatsAppOverdueAnswer(contact, NOW_MS)).resolves.toEqual({
      earliestSentAtMs: minutesBefore(20),
    });
  });
});
