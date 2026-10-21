import { describe, expect, it } from "vitest";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { withWhatsAppUnansweredMessagesContext } from "./unanswered-messages-context.js";

const contact = { label: "WhatsApp contact", source: "whatsapp", type: "contact", payload: {} };
const msg = { payload: { body: "And towels?", channelStructuredContext: [contact] } } as never;
const message = (text: string | undefined, sentAtMs?: number) => ({
  receivedAtMs: 1,
  ...(sentAtMs !== undefined ? { sentAtMs } : {}),
  ...(text !== undefined ? { text } : {}),
});

describe("WhatsApp messages without an answer", () => {
  it("adds nothing for one message: the turn reads it anyway", () => {
    expect(withWhatsAppUnansweredMessagesContext(msg, [message("And towels?")])).toBe(msg);
  });

  it("lists every unanswered message after the existing context", () => {
    const result: AdmittedWebInboundMessage = withWhatsAppUnansweredMessagesContext(msg, [
      message("Check-in time?", Date.UTC(2026, 9, 20, 17, 21)),
      message(undefined),
      message("And towels?", Date.UTC(2026, 9, 20, 17, 22)),
    ]);
    expect(result.payload.body).toBe("And towels?");
    expect(result.payload.channelStructuredContext).toEqual([
      contact,
      {
        label: "WhatsApp messages without an answer",
        source: "whatsapp",
        type: "unanswered_messages",
        payload: {
          messages: [
            { sent_at: "2026-10-20T17:21:00.000Z", text: "Check-in time?" },
            { sent_at: null, text: null },
            { sent_at: "2026-10-20T17:22:00.000Z", text: "And towels?" },
          ],
          rule: expect.stringContaining("The next reply to the person answers all of them"),
        },
      },
    ]);
  });
});
