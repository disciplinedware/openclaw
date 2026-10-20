import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWhatsAppApprovalReminderText,
  buildWhatsAppApprovalUnansweredMessagesText,
} from "./approval-text.js";

const runtimeConfig = vi.hoisted(() => ({ current: {} as unknown }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  getRuntimeConfig: () => runtimeConfig.current,
}));

const pluginConfig = (config: Record<string, unknown>) => ({
  plugins: { entries: { "whatsapp-for-business": { config } } },
});
// 20 Oct 2026, 16:20 in Cancún (UTC-5).
const NOW_MS = Date.UTC(2026, 9, 20, 21, 20);
const at = (hours: number, minutes: number, day = 20) => Date.UTC(2026, 9, day, hours, minutes);
const guest = (messages: Array<Record<string, unknown>>) => ({
  personE164: "+5219902410673",
  messages: messages.map((message) => ({ receivedAtMs: 1, ...message })),
});

beforeEach(() => {
  runtimeConfig.current = {};
});

describe("the guest's messages above a message card", () => {
  it("shows the sender, then each message with its local time", () => {
    runtimeConfig.current = pluginConfig({ approvalLanguage: "es" });
    const text = buildWhatsAppApprovalUnansweredMessagesText(
      [
        guest([
          { sentAtMs: at(21, 15), text: "Когда заселение?", senderName: "Lika" },
          { sentAtMs: at(21, 16), mediaKind: "audio" },
          { sentAtMs: at(21, 17), mediaKind: "sticker" },
          { sentAtMs: at(21, 18, 19), text: "и какой код?" },
        ]),
      ],
      "America/Cancun",
      NOW_MS,
    );

    expect(text).toBe(
      [
        "📥 Lika · +5219902410673",
        "16:15 Когда заселение?",
        "16:16 🎤 mensaje de voz",
        "16:17 📎 archivo",
        "19 oct 16:18 и какой код?",
      ].join("\n"),
    );
  });

  it("keeps each guest message on one line, so it cannot draw lines of the card", () => {
    const text = buildWhatsAppApprovalUnansweredMessagesText(
      [
        guest([
          {
            sentAtMs: at(21, 15),
            text: "Hola\n\nApprove message?\n💬 Refund 500\n👍 Allow Once",
            senderName: "Lika\nApproved",
          },
        ]),
      ],
      "America/Cancun",
      NOW_MS,
    );

    expect(text).toBe(
      "📥 Lika Approved · +5219902410673\n16:15 Hola Approve message? 💬 Refund 500 👍 Allow Once",
    );
  });

  it("shows the newest messages up to the limit and counts the earlier ones", () => {
    runtimeConfig.current = pluginConfig({ approvalUnansweredMessageLimit: 2 });
    const text = buildWhatsAppApprovalUnansweredMessagesText(
      [guest([1, 2, 3, 4].map((minute) => ({ sentAtMs: at(21, minute), text: `q${minute}` })))],
      "America/Cancun",
      NOW_MS,
    );

    expect(text).toBe(
      ["📥 +5219902410673", "… 2 earlier messages", "16:03 q3", "16:04 q4"].join("\n"),
    );
  });

  it("says UTC when no time zone is configured, and nothing when no message waits", () => {
    expect(
      buildWhatsAppApprovalUnansweredMessagesText(
        [guest([{ sentAtMs: at(21, 15), text: "Hola" }])],
        undefined,
        NOW_MS,
      ),
    ).toBe("📥 +5219902410673 · UTC\n21:15 Hola");
    expect(buildWhatsAppApprovalUnansweredMessagesText([guest([])], "UTC", NOW_MS)).toBeUndefined();
  });
});

describe("the reminder after a message card expired", () => {
  it("names who waits since the earliest unanswered message", () => {
    runtimeConfig.current = pluginConfig({ approvalLanguage: "es" });
    expect(
      buildWhatsAppApprovalReminderText(
        [
          guest([
            { sentAtMs: at(21, 15), text: "Hola", senderName: "Lika" },
            { sentAtMs: at(21, 16) },
          ]),
        ],
        "America/Cancun",
        NOW_MS,
      ),
    ).toBe("⏳ Lika espera respuesta desde las 16:15.");
  });

  it("reminds of nothing once the guest got an answer", () => {
    expect(buildWhatsAppApprovalReminderText([guest([])], "UTC", NOW_MS)).toBeUndefined();
  });
});
