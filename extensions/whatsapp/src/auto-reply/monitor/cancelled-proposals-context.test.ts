import { describe, expect, it } from "vitest";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { withWhatsAppCancelledProposalsContext } from "./cancelled-proposals-context.js";

const contact = { label: "WhatsApp contact", source: "whatsapp", type: "contact", payload: {} };
const msg = { payload: { body: "как дела?", channelStructuredContext: [contact] } } as never;

describe("WhatsApp proposals cancelled before a decision", () => {
  it("adds nothing when no proposal of the session was cancelled", () => {
    expect(withWhatsAppCancelledProposalsContext(msg, [])).toBe(msg);
  });

  it("gives the turn each cancelled proposal with its recipients and card", () => {
    const result: AdmittedWebInboundMessage = withWhatsAppCancelledProposalsContext(msg, [
      {
        recipients: ["+5219902410673"],
        description: "💬 Mañana a las 10 hay limpieza.",
        cancelledAtMs: Date.UTC(2026, 9, 20, 21, 17),
      },
      { recipients: ["+15550000300"], cancelledAtMs: Date.UTC(2026, 9, 20, 21, 18) },
    ]);

    expect(result.payload.body).toBe("как дела?");
    expect(result.payload.channelStructuredContext).toEqual([
      contact,
      {
        label: "WhatsApp proposals cancelled before a decision",
        source: "whatsapp",
        type: "cancelled_proposals",
        payload: {
          proposals: [
            {
              recipients: ["+5219902410673"],
              cancelled_at: "2026-10-20T21:17:00.000Z",
              card: "💬 Mañana a las 10 hay limpieza.",
            },
            { recipients: ["+15550000300"], cancelled_at: "2026-10-20T21:18:00.000Z", card: null },
          ],
          rule: expect.stringContaining(
            "Propose again each one that the conversation still asks for",
          ),
        },
      },
    ]);
  });
});
