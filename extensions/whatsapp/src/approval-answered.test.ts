import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWhatsAppMessageCardsForTest,
  closeWhatsAppMessageCardsAnsweredByBusiness,
  trackOpenWhatsAppMessageCard,
} from "./approval-answered.js";
import { whatsappApprovalNativeRuntime } from "./approval-handler.runtime.js";

const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolver.resolve,
}));

const OWNER = "+447700900001";
const GUEST_SESSION = "agent:assistant:whatsapp:default:direct:+447700900002";
const OTHER_GUEST_SESSION = "agent:assistant:whatsapp:default:direct:+447700900003";
const cfg = {
  commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] },
  plugins: { entries: { "whatsapp-for-business": { config: { approvalLanguage: "es" } } } },
};

function card(id: string, sessionKey: string) {
  return {
    id,
    request: { toolName: "message", sessionKey, turnSourceAccountId: "default" },
    createdAtMs: 0,
    expiresAtMs: 300_000,
  };
}

async function outcome(id: string, decision: "allow-once" | "deny") {
  const result = await whatsappApprovalNativeRuntime.presentation.buildResolvedResult({
    cfg,
    request: card(id, GUEST_SESSION),
    resolved: { decision },
    view: { approvalKind: "plugin" },
  } as never);
  return (result as { payload: { text: string; cardOutcome?: string } }).payload;
}

afterEach(() => {
  clearWhatsAppMessageCardsForTest();
  resolver.resolve.mockReset();
});

describe("cards a business reply makes stale", () => {
  it("refuses_the_open_cards_of_the_answered_guest_only", async () => {
    trackOpenWhatsAppMessageCard({ request: card("plugin:a", GUEST_SESSION) } as never);
    trackOpenWhatsAppMessageCard({ request: card("plugin:b", OTHER_GUEST_SESSION) } as never);
    await closeWhatsAppMessageCardsAnsweredByBusiness({ cfg, sessionKey: GUEST_SESSION } as never);
    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(resolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plugin:a",
        approvalKind: "plugin",
        decision: "deny",
        channel: "whatsapp",
        accountId: "default",
        senderId: OWNER,
      }),
    );
  });

  it("shows_answered_on_the_closed_card_and_rejected_on_another", async () => {
    trackOpenWhatsAppMessageCard({ request: card("plugin:a", GUEST_SESSION) } as never);
    await closeWhatsAppMessageCardsAnsweredByBusiness({ cfg, sessionKey: GUEST_SESSION } as never);
    expect(await outcome("plugin:a", "deny")).toEqual({
      text: "↪️ Ya respondido.",
      cardOutcome: "↪️ Ya respondido.",
    });
    expect((await outcome("plugin:z", "deny")).cardOutcome).toBe("❌ Rechazado.");
    expect((await outcome("plugin:y", "allow-once")).cardOutcome).toBe("✅ Aprobado.");
  });

  it("keeps_the_card_open_and_unmarked_when_the_refusal_fails", async () => {
    resolver.resolve.mockRejectedValueOnce(new Error("gateway unavailable"));
    trackOpenWhatsAppMessageCard({ request: card("plugin:a", GUEST_SESSION) } as never);
    await closeWhatsAppMessageCardsAnsweredByBusiness({ cfg, sessionKey: GUEST_SESSION } as never);
    expect((await outcome("plugin:a", "deny")).cardOutcome).toBe("❌ Rechazado.");
  });

  it("closes_nothing_without_a_whatsapp_owner", async () => {
    trackOpenWhatsAppMessageCard({ request: card("plugin:a", GUEST_SESSION) } as never);
    await closeWhatsAppMessageCardsAnsweredByBusiness({
      cfg: { commands: { ownerAllowFrom: [] } },
      sessionKey: GUEST_SESSION,
    } as never);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
