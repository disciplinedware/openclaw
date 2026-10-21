import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWhatsAppApprovalCardClosed,
  readWhatsAppCancelledProposals,
  recordWhatsAppApprovalCardClosed,
  recordWhatsAppApprovalCardDelivered,
  consumeWhatsAppApprovalCardsReplacedBy,
  type WhatsAppApprovalCard,
} from "./approval-cards.js";
import { createMemoryPluginStateRuntime } from "./plugin-state.test-helper.js";

const runtimes = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getWhatsAppRuntime: () => runtimes.current,
  getOptionalWhatsAppRuntime: () => runtimes.current,
}));

const MINUTE_MS = 60_000;
const NOW_MS = Date.UTC(2026, 9, 20, 21, 20);
let serial = 0;
const card = (overrides: Partial<WhatsAppApprovalCard> = {}): WhatsAppApprovalCard => ({
  accountId: "default",
  remoteJid: "79262070342@s.whatsapp.net",
  messageId: `card-${++serial}`,
  recipients: ["+5219902410673"],
  sourceSessionKey: "agent:assistant:whatsapp:default:direct:+5219902410673",
  description: "💬 Код двери 4821.",
  ...overrides,
});

beforeEach(() => {
  runtimes.current = createMemoryPluginStateRuntime().runtime;
});

describe("WhatsApp approval cards", () => {
  it("knows a card whose approval ended, whatever ended it", async () => {
    const decided = card();
    const pending = card();
    await recordWhatsAppApprovalCardClosed(decided, "decided", NOW_MS);

    await expect(isWhatsAppApprovalCardClosed(decided)).resolves.toBe(true);
    await expect(isWhatsAppApprovalCardClosed(pending)).resolves.toBe(false);
  });

  it("hands a cancelled card to the next card for the same recipient in the same chat, once", async () => {
    const cancelled = card();
    await recordWhatsAppApprovalCardClosed(cancelled, "cancelled", NOW_MS);

    await expect(
      consumeWhatsAppApprovalCardsReplacedBy(card({ recipients: ["+15550000300"] })),
    ).resolves.toEqual([]);
    await expect(
      consumeWhatsAppApprovalCardsReplacedBy(card({ remoteJid: "15550000200@s.whatsapp.net" })),
    ).resolves.toEqual([]);
    await expect(consumeWhatsAppApprovalCardsReplacedBy(card())).resolves.toEqual([cancelled]);
    await expect(consumeWhatsAppApprovalCardsReplacedBy(card())).resolves.toEqual([]);
  });

  it("replaces no card that its approver decided or that expired", async () => {
    await recordWhatsAppApprovalCardClosed(card(), "decided", NOW_MS);
    await recordWhatsAppApprovalCardClosed(card(), "expired", NOW_MS);

    await expect(consumeWhatsAppApprovalCardsReplacedBy(card())).resolves.toEqual([]);
  });

  it("keeps a cancelled proposal for its session until a new card to that recipient", async () => {
    const host = "agent:host:whatsapp:default:direct:+79262070342";
    const cancelled = card({ sourceSessionKey: host });
    await recordWhatsAppApprovalCardDelivered(cancelled);
    await recordWhatsAppApprovalCardClosed(cancelled, "cancelled", NOW_MS);

    await expect(readWhatsAppCancelledProposals(host, NOW_MS + MINUTE_MS)).resolves.toEqual([
      { recipients: ["+5219902410673"], description: "💬 Код двери 4821.", cancelledAtMs: NOW_MS },
    ]);
    await expect(
      readWhatsAppCancelledProposals("agent:assistant:whatsapp:default:direct:+1", NOW_MS),
    ).resolves.toEqual([]);

    await consumeWhatsAppApprovalCardsReplacedBy(card({ sourceSessionKey: host }));
    await expect(readWhatsAppCancelledProposals(host, NOW_MS)).resolves.toEqual([]);
  });

  it("gives the next turn a proposal whose card is still open: the ended run is cancelling it", async () => {
    const guest = "agent:assistant:whatsapp:default:direct:+5219902410673";
    await recordWhatsAppApprovalCardDelivered(card({ sourceSessionKey: guest }));

    await expect(readWhatsAppCancelledProposals(guest, NOW_MS)).resolves.toEqual([
      { recipients: ["+5219902410673"], description: "💬 Код двери 4821.", cancelledAtMs: NOW_MS },
    ]);
  });

  it("forgets a proposal that its approver decided or that expired", async () => {
    const guest = "agent:assistant:whatsapp:default:direct:+5219902410673";
    const decided = card({ sourceSessionKey: guest });
    const expired = card({ sourceSessionKey: guest });
    await recordWhatsAppApprovalCardDelivered(decided);
    await recordWhatsAppApprovalCardDelivered(expired);
    await recordWhatsAppApprovalCardClosed(decided, "decided", NOW_MS);
    await recordWhatsAppApprovalCardClosed(expired, "expired", NOW_MS);

    await expect(readWhatsAppCancelledProposals(guest, NOW_MS)).resolves.toEqual([]);
  });

  it("does not bring back a proposal that a newer card proposed again before its cancellation was recorded", async () => {
    const guest = "agent:assistant:whatsapp:default:direct:+5219902410673";
    const cancelled = card({ sourceSessionKey: guest });
    await recordWhatsAppApprovalCardDelivered(cancelled);
    await consumeWhatsAppApprovalCardsReplacedBy(card({ sourceSessionKey: guest }));
    await recordWhatsAppApprovalCardClosed(cancelled, "cancelled", NOW_MS);

    await expect(readWhatsAppCancelledProposals(guest, NOW_MS)).resolves.toEqual([]);
  });

  it("leaves a cancelled proposal to the approver once the answer is overdue", async () => {
    const host = "agent:host:whatsapp:default:direct:+79262070342";
    const cancelled = card({ sourceSessionKey: host });
    await recordWhatsAppApprovalCardDelivered(cancelled);
    await recordWhatsAppApprovalCardClosed(cancelled, "cancelled", NOW_MS);

    await expect(readWhatsAppCancelledProposals(host, NOW_MS + 16 * MINUTE_MS)).resolves.toEqual(
      [],
    );
  });

  it("reads no card in a process without the plugin's runtime", async () => {
    runtimes.current = undefined;
    await expect(isWhatsAppApprovalCardClosed(card())).resolves.toBe(false);
    await expect(readWhatsAppCancelledProposals("agent:host:x", NOW_MS)).resolves.toEqual([]);
  });
});
