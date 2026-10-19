import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { toWhatsappJidWithLid } from "../targets-runtime.js";
import {
  readWhatsAppBaileysCacheEntry,
  rememberWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysCacheEntry,
} from "./baileys-cache.js";

/** How long WhatsApp's answer about a number's registration is reused, either way. */
const REGISTRATION_TTL_MS = 60 * 60 * 1000;
const PHONE_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;

/** Baileys' `sock.onWhatsApp`: the registered JID of each number WhatsApp knows. */
export type WhatsAppRegistrationLookup = (
  phoneJid: string,
) => Promise<Array<{ jid: string; exists: boolean }> | undefined>;

const stripChannelPrefix = (to: string): string => to.replace(/^whatsapp:/i, "").trim();

/** The digits WhatsApp registers a number under, or `null` when WhatsApp has no such account. */
type Registration = { registeredDigits: string | null };

/**
 * Resolves a send target to the chat WhatsApp registered for it. A phone number is not always
 * registered under its E.164 digits (a Mexican mobile `+52…` is `521…`), so a number goes to the
 * JID that `sock.onWhatsApp` reports, never to one built from its digits. A JID target is already
 * a chat and passes unchanged.
 */
export function createWhatsAppRecipientResolver(deps: {
  lookup: WhatsAppRegistrationLookup;
  authDir?: string;
}) {
  const registrations = new Map<string, WhatsAppBaileysCacheEntry<Registration>>();
  const inflight = new Map<string, Promise<Registration>>();

  /** The account's LID for these digits, which Baileys stores only for a number it has met. */
  const toLidJidOrPhoneJid = (digits: string): string =>
    toWhatsappJidWithLid(`+${digits}`, { authDir: deps.authDir });

  const lookupRegistration = async (digits: string): Promise<Registration> => {
    const lookupFailed = (cause: unknown) =>
      new PlatformMessageNotDispatchedError(
        `WhatsApp could not check whether +${digits} has an account; nothing was sent. Retry later.`,
        { cause, retryable: true },
      );
    let results: Awaited<ReturnType<WhatsAppRegistrationLookup>>;
    try {
      results = await deps.lookup(`${digits}@s.whatsapp.net`);
    } catch (error) {
      throw lookupFailed(error);
    }
    if (!results) {
      throw lookupFailed(new Error("WhatsApp returned no answer to the registration lookup"));
    }
    const registered = results.find((result) => result.exists);
    if (!registered) {
      return { registeredDigits: null };
    }
    return { registeredDigits: registered.jid.match(PHONE_JID_RE)?.[1] ?? digits };
  };

  const resolveRegistration = async (digits: string): Promise<Registration> => {
    // A number with a stored LID mapping has already reached this account under these digits.
    if (toLidJidOrPhoneJid(digits).endsWith("@lid")) {
      return { registeredDigits: digits };
    }
    const cached = readWhatsAppBaileysCacheEntry(registrations, digits);
    if (cached) {
      return cached;
    }
    const pending = inflight.get(digits);
    if (pending) {
      return await pending;
    }
    const request = lookupRegistration(digits)
      .then((registration) => {
        rememberWhatsAppBaileysCacheEntry(registrations, digits, registration, REGISTRATION_TTL_MS);
        return registration;
      })
      .finally(() => {
        inflight.delete(digits);
      });
    inflight.set(digits, request);
    return await request;
  };

  /** The registered digits of a number; refuses a number WhatsApp has no account for. */
  const requireRegisteredDigits = async (e164: string): Promise<string> => {
    const digits = normalizeE164(e164).replace(/\D/g, "");
    if (!digits) {
      throw new PlatformMessageNotDispatchedError(`"${e164}" is not a phone number`, {
        cause: new Error("empty phone number"),
        retryable: false,
      });
    }
    const { registeredDigits } = await resolveRegistration(digits);
    if (!registeredDigits) {
      const message = `WhatsApp has no account for +${digits}; nothing was sent. Check the number.`;
      throw new PlatformMessageNotDispatchedError(message, {
        cause: new Error("WhatsApp reports no account for the number"),
        retryable: false,
      });
    }
    return registeredDigits;
  };

  /** The chat `to` names as a phone JID: a JID unchanged, a number at its registered digits. */
  const resolvePhoneJid = async (to: string): Promise<string> => {
    const target = stripChannelPrefix(to);
    return target.includes("@")
      ? target
      : `${await requireRegisteredDigits(target)}@s.whatsapp.net`;
  };

  /** The JID a send to `to` goes to: a JID unchanged, a number at its registered chat's LID or JID. */
  const resolveSendJid = async (to: string): Promise<string> => {
    const target = stripChannelPrefix(to);
    return target.includes("@")
      ? target
      : toLidJidOrPhoneJid(await requireRegisteredDigits(target));
  };

  /** A number as WhatsApp registers it, as E.164: the person inbound messages name. */
  const resolveE164 = async (e164: string): Promise<string> =>
    `+${await requireRegisteredDigits(e164)}`;

  /** Drops what is known about a number, so the next send asks WhatsApp again. */
  const forget = (to: string): void => {
    const target = stripChannelPrefix(to);
    if (!target.includes("@")) {
      registrations.delete(normalizeE164(target).replace(/\D/g, ""));
    }
  };

  return { resolvePhoneJid, resolveSendJid, resolveE164, forget } as const;
}

export type WhatsAppRecipientResolver = ReturnType<typeof createWhatsAppRecipientResolver>;
