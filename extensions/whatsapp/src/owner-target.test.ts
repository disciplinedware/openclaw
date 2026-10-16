import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
// The `owner` messaging target: opaque to core and hooks, resolved only by the transport send.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappChannelOutbound } from "./channel-outbound.js";
import { whatsappPlugin } from "./channel.js";
import type { WhatsAppSendResult } from "./inbound/send-result.js";
import { listWhatsAppDeliveredMessageIdentities } from "./inbound/send-result.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { looksLikeWhatsAppTargetId, normalizeWhatsAppMessagingTarget } from "./normalize-target.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
import {
  sendMessageWhatsApp,
  sendPollWhatsApp,
  sendReactionWhatsApp,
  sendTypingWhatsApp,
} from "./send.js";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";

const listeners = vi.hoisted(() => new Map<string, ActiveWebListener>());

vi.mock("./connection-controller-runtime-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection-controller-runtime-context.js")>()),
  getWhatsAppConnectionController: (accountId: string) => {
    const listener = listeners.get(accountId);
    return listener ? { getActiveListener: () => listener } : null;
  },
}));

const OWNER = "+15550000200";
const OWNER_DIGITS = "15550000200";
const OWNER_JID = `${OWNER_DIGITS}@s.whatsapp.net`;
const OWNER_LID = "987654321012345@lid";
const GUEST = "+15550000300";

const cfgWithOwners = (...owners: string[]): OpenClawConfig => ({
  channels: { whatsapp: {} },
  commands: { ownerAllowFrom: owners },
});
const CFG = cfgWithOwners(`whatsapp:${OWNER}`, "telegram:42");

/** Every string the owner could be known by: the number, its digits and its chat ids. */
const expectNoOwnerIdentity = (value: unknown) => {
  const serialized =
    value instanceof Error
      ? JSON.stringify({ ...value, message: value.message, stack: value.stack })
      : JSON.stringify(value);
  expect(serialized).not.toContain(OWNER_DIGITS);
  expect(serialized).not.toContain("@lid");
};

function acceptedSend(id: string, remoteJid: string): WhatsAppSendResult {
  return {
    kind: "text",
    messageId: id,
    receipt: createMessageReceiptFromOutboundResults({
      kind: "text",
      results: [{ channel: "whatsapp", messageId: id, toJid: remoteJid }],
    }),
    keys: [{ id, remoteJid, fromMe: true }],
    providerAccepted: true,
  };
}

const sendMessage = vi.fn(async (_to: string, _text: string) => acceptedSend("m1", OWNER_JID));
const sendPoll = vi.fn(async () => ({ ...acceptedSend("p1", OWNER_LID), kind: "poll" as const }));
const sendReaction = vi.fn(async () => ({
  ...acceptedSend("r1", OWNER_JID),
  kind: "reaction" as const,
}));
const sendComposingTo = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  listeners.set("default", { sendMessage, sendPoll, sendReaction, sendComposingTo });
});

describe("owner target before the transport", () => {
  it.each(["owner", "OWNER", " whatsapp:owner ", "whatsapp:whatsapp:Owner"])(
    "normalizes %j to the opaque owner target",
    (raw) => {
      expect(normalizeWhatsAppMessagingTarget(raw)).toBe("owner");
      expect(looksLikeWhatsAppTargetId(raw)).toBe(true);
    },
  );

  it("keeps owner opaque through the outbound resolver, whatever allowFrom says", () => {
    expect(
      resolveWhatsAppOutboundTarget({ to: "whatsapp:owner", allowFrom: [GUEST], mode: "explicit" }),
    ).toEqual({ ok: true, to: "owner" });
  });

  it("gives owner a direct chat type and no session route that would carry the number", () => {
    expect(whatsappPlugin.messaging?.inferTargetChatType?.({ to: "owner" })).toBe("direct");
    expect(
      resolveWhatsAppOutboundSessionRoute({
        cfg: CFG,
        agentId: "main",
        accountId: "default",
        target: "owner",
      }),
    ).toBeNull();
  });

  it("does not take owner for a phone number anywhere else", () => {
    expect(normalizeWhatsAppMessagingTarget("ownerx")).toBeUndefined();
    expect(normalizeWhatsAppMessagingTarget(GUEST)).toBe(GUEST);
  });
});

describe("owner target in the transport send", () => {
  it("resolves owner to the one WhatsApp owner only at send and returns no number", async () => {
    const result = await sendMessageWhatsApp("owner", "A guest asks for a late checkout.", {
      verbose: false,
      cfg: CFG,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      OWNER,
      "A guest asks for a late checkout.",
      undefined,
      undefined,
    );
    expect(sendComposingTo).toHaveBeenCalledWith(OWNER);
    expect(result).toEqual({ messageId: "m1", toJid: "owner" });
  });

  it("keeps the number out of progress receipts of a chunked send", async () => {
    const progress: unknown[] = [];

    await sendMessageWhatsApp("owner", "first part second part", {
      verbose: false,
      cfg: CFG,
      formatting: { textLimit: 11 },
      onDeliveryResult: (delivered) => {
        progress.push(delivered);
      },
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(progress.length).toBe(sendMessage.mock.calls.length);
    for (const delivered of progress) {
      expect(delivered).toEqual(expect.objectContaining({ toJid: "owner" }));
      expectNoOwnerIdentity(delivered);
    }
  });

  it("keeps the number out of a send error and keeps the error's class", async () => {
    sendMessage
      .mockResolvedValueOnce(acceptedSend("m1", OWNER_JID))
      .mockRejectedValueOnce(new Error(`socket closed while sending to ${OWNER_JID} (${OWNER})`));

    const error = await sendMessageWhatsApp("owner", "first part second part", {
      verbose: false,
      cfg: CFG,
      formatting: { textLimit: 11 },
    }).catch((err: unknown) => err);

    // The first part was delivered, so recovery must still see a partial delivery.
    expect(isChannelPartialDeliveryError(error)).toBe(true);
    expect((error as Error).message).toContain("owner");
    expectNoOwnerIdentity(error);
    expectNoOwnerIdentity((error as { deliveryResult?: unknown }).deliveryResult);
  });

  it("resolves owner for polls, typing and reactions too", async () => {
    const poll = await sendPollWhatsApp(
      "owner",
      { question: "Late checkout?", options: ["Yes", "No"] },
      { verbose: false, cfg: CFG },
    );
    await sendTypingWhatsApp("owner", { cfg: CFG });
    await sendReactionWhatsApp("owner", "m1", "👍", { verbose: false, cfg: CFG });

    expect(sendPoll).toHaveBeenCalledWith(OWNER, expect.anything());
    expect(poll).toEqual({ messageId: "p1", toJid: "owner" });
    expect(sendComposingTo).toHaveBeenCalledWith(OWNER);
    expect(sendReaction).toHaveBeenCalledWith(OWNER, "m1", "👍", false, undefined);
  });

  it.each([
    ["no WhatsApp owner", cfgWithOwners("telegram:42"), "none is configured"],
    ["two WhatsApp owners", cfgWithOwners(OWNER, "whatsapp:+15550000201"), "2 are configured"],
  ])("refuses owner with %s and names no number", async (_label, cfg, detail) => {
    const error = await sendMessageWhatsApp("owner", "hello", { verbose: false, cfg }).catch(
      (err: unknown) => err,
    );

    expect((error as Error).message).toBe(
      `WhatsApp target "owner" needs exactly one WhatsApp owner in commands.ownerAllowFrom; ${detail}.`,
    );
    expect((error as Error).message).not.toMatch(/\d{5}/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("leaves every other target and its result as they were", async () => {
    sendMessage.mockResolvedValueOnce(acceptedSend("m2", "15550000300@s.whatsapp.net"));

    const result = await sendMessageWhatsApp(GUEST, "hi", { verbose: false, cfg: CFG });

    expect(sendMessage).toHaveBeenCalledWith(GUEST, "hi", undefined, undefined);
    expect(result).toEqual({ messageId: "m2", toJid: "15550000300@s.whatsapp.net" });
  });
});

describe("a reply to owner through the outbound adapter", () => {
  it("quotes in the owner's chat and still returns no number", async () => {
    const result = await whatsappChannelOutbound.sendText!({
      cfg: CFG,
      to: "owner",
      text: "Approved.",
      replyToId: "q1",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      OWNER,
      "Approved.",
      undefined,
      undefined,
      expect.objectContaining({
        quotedMessageKey: expect.objectContaining({ id: "q1", remoteJid: OWNER_JID }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ messageId: "m1", toJid: "owner" }));
  });
});

describe("owner identity redaction", () => {
  it("replaces the number, its chat ids and LIDs in an error, and keeps unrelated values", async () => {
    sendMessage.mockRejectedValueOnce(
      Object.assign(
        new Error(
          `failed: ${OWNER_DIGITS}:12@s.whatsapp.net ${OWNER_DIGITS}@c.us ${OWNER_LID} ` +
            `call ${OWNER} or ${OWNER_DIGITS}; other +155500002001`,
        ),
        { attempt: { toJid: OWNER_JID, count: 2 } },
      ),
    );

    const error = await sendMessageWhatsApp("owner", "hello", { verbose: false, cfg: CFG }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toMatchObject({
      message: "failed: owner owner owner call owner or owner; other +155500002001",
      attempt: { toJid: "owner", count: 2 },
    });
  });
});

describe("reaction bindings of a send to owner", () => {
  it("restores the owner's chat id inside the plugin", () => {
    expect(
      listWhatsAppDeliveredMessageIdentities(
        [{ channel: "whatsapp", messageId: "m1", toJid: "owner" }],
        () => true,
        CFG,
      ),
    ).toEqual([{ messageId: "m1", remoteJid: OWNER_JID }]);
    expect(
      listWhatsAppDeliveredMessageIdentities(
        [{ channel: "whatsapp", messageId: "m1", toJid: "owner" }],
        () => true,
        cfgWithOwners(),
      ),
    ).toEqual([]);
  });
});
