import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWhatsAppRecipientResolver,
  type WhatsAppRegistrationLookup,
} from "./recipient-resolver.js";

const MX_E164 = "+525500000000";
const MX_REGISTERED_JID = "5215500000000@s.whatsapp.net";

describe("createWhatsAppRecipientResolver", () => {
  let authDir: string;

  beforeEach(() => {
    authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-recipient-"));
  });

  afterEach(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const registeredAs =
    (jid: string): WhatsAppRegistrationLookup =>
    async () => [{ jid, exists: true }];

  it("sends_a_number_to_the_jid_whatsapp_registered_for_it", async () => {
    const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await expect(resolver.resolveSendJid(MX_E164)).resolves.toBe(MX_REGISTERED_JID);
    await expect(resolver.resolveE164(MX_E164)).resolves.toBe("+5215500000000");
    expect(lookup).toHaveBeenCalledWith("525500000000@s.whatsapp.net");
  });

  it("refuses_a_number_whatsapp_has_no_account_for", async () => {
    const resolver = createWhatsAppRecipientResolver({ lookup: async () => [], authDir });

    const error = await resolver.resolveSendJid("+15550001111").catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "PlatformMessageNotDispatchedError", retryable: false });
    expect(String(error)).toContain("WhatsApp has no account for +15550001111");
  });

  it.each([
    ["network_error", () => Promise.reject(new Error("socket closed"))],
    ["no_answer", () => Promise.resolve(undefined)],
  ] as const)("fails_retryably_when_the_lookup_fails_%s", async (_name, lookup) => {
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    const error = await resolver.resolveSendJid(MX_E164).catch((err: unknown) => err);

    expect(error).toMatchObject({ name: "PlatformMessageNotDispatchedError", retryable: true });
  });

  it("does_not_cache_a_failed_lookup", async () => {
    const lookup = vi
      .fn<WhatsAppRegistrationLookup>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce([{ jid: MX_REGISTERED_JID, exists: true }]);
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await expect(resolver.resolveSendJid(MX_E164)).rejects.toThrow("Retry later");
    await expect(resolver.resolveSendJid(MX_E164)).resolves.toBe(MX_REGISTERED_JID);
  });

  it("reuses_one_lookup_for_repeated_and_concurrent_sends", async () => {
    const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await Promise.all([
      resolver.resolveSendJid(MX_E164),
      resolver.resolveSendJid(`whatsapp:${MX_E164}`),
    ]);
    await resolver.resolveE164(MX_E164);

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("caches_a_refusal_too", async () => {
    const lookup = vi.fn<WhatsAppRegistrationLookup>(async () => []);
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await expect(resolver.resolveSendJid("+15550001111")).rejects.toThrow("no account");
    await expect(resolver.resolveSendJid("+15550001111")).rejects.toThrow("no account");

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("asks_whatsapp_again_after_forget", async () => {
    const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await resolver.resolveSendJid(MX_E164);
    resolver.forget(MX_E164);
    await resolver.resolveSendJid(MX_E164);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("asks_whatsapp_again_after_the_ttl", async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
      const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

      await resolver.resolveSendJid(MX_E164);
      vi.advanceTimersByTime(60 * 60 * 1000 + 1);
      await resolver.resolveSendJid(MX_E164);

      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses_the_stored_lid_of_the_registered_number", async () => {
    fs.writeFileSync(path.join(authDir, "lid-mapping-5215500000000.json"), JSON.stringify("777"));
    const resolver = createWhatsAppRecipientResolver({
      lookup: registeredAs(MX_REGISTERED_JID),
      authDir,
    });

    await expect(resolver.resolveSendJid(MX_E164)).resolves.toBe("777@lid");
  });

  it("skips_the_lookup_for_a_number_with_a_stored_lid", async () => {
    fs.writeFileSync(path.join(authDir, "lid-mapping-5215500000000.json"), JSON.stringify("777"));
    const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await expect(resolver.resolveSendJid("+5215500000000")).resolves.toBe("777@lid");
    await expect(resolver.resolveE164("+5215500000000")).resolves.toBe("+5215500000000");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "120363000000000000@g.us",
    "120363401234567890@newsletter",
    "777@lid",
    "5215500000000@s.whatsapp.net",
  ])("passes_a_jid_target_unchanged_%s", async (jid) => {
    const lookup = vi.fn(registeredAs(MX_REGISTERED_JID));
    const resolver = createWhatsAppRecipientResolver({ lookup, authDir });

    await expect(resolver.resolveSendJid(`whatsapp:${jid}`)).resolves.toBe(jid);
    expect(lookup).not.toHaveBeenCalled();
  });
});
