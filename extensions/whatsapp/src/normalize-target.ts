import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

const WHATSAPP_USER_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const WHATSAPP_LEGACY_USER_JID_RE = /^(\d+)@c\.us$/i;
const WHATSAPP_LID_RE = /^(\d+)@lid$/i;
const NON_WHATSAPP_PROVIDER_PREFIX_RE = /^[a-z][a-z0-9-]*:/i;
const WHATSAPP_NEWSLETTER_JID_RE = /^([0-9]+)@newsletter$/i;

function stripWhatsAppTargetPrefixes(value: string): string {
  let candidate = value.trim();
  for (;;) {
    const before = candidate;
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
    if (candidate === before) {
      return candidate;
    }
  }
}

/** The send target that names the owner (`commands.ownerAllowFrom`) without the owner's number. */
export const WHATSAPP_OWNER_TARGET = "owner";

function isWhatsAppOwnerTarget(raw: string): boolean {
  return stripWhatsAppTargetPrefixes(raw).toLowerCase() === WHATSAPP_OWNER_TARGET;
}

function normalizeWhatsAppGroupJid(candidate: string): string | null {
  const match = /^(\d+(?:-\d+)*)@g\.us$/i.exec(candidate.replace(/^group:/i, "").trim());
  return match ? `${match[1]}@g.us` : null;
}

export function isWhatsAppGroupJid(value: string): boolean {
  return normalizeWhatsAppGroupJid(stripWhatsAppTargetPrefixes(value)) !== null;
}

export function isWhatsAppNewsletterJid(value: string): boolean {
  const candidate = stripWhatsAppTargetPrefixes(value);
  return WHATSAPP_NEWSLETTER_JID_RE.test(candidate);
}

export function isWhatsAppUserTarget(value: string): boolean {
  return extractUserJidPhone(stripWhatsAppTargetPrefixes(value)) !== null;
}

function extractUserJidPhone(jid: string): string | null {
  return (
    (jid.match(WHATSAPP_USER_JID_RE) ??
      jid.match(WHATSAPP_LEGACY_USER_JID_RE) ??
      jid.match(WHATSAPP_LID_RE))?.[1] ?? null
  );
}

/**
 * One number per Mexican mobile: WhatsApp keeps accounts made before Mexico's 2019 dial plan under
 * 521 + ten digits, the number is written +52 + ten digits, and no Mexican area code starts with 1.
 * A send finds the registered chat again (`lookupRegisteredJid` in inbound/send-api.ts).
 */
export function normalizeMexicanMobileE164(e164: string): string {
  return e164.replace(/^\+521(\d{10})$/, "+52$1");
}

export function normalizeWhatsAppTarget(value: string): string | null {
  const candidate = stripWhatsAppTargetPrefixes(value);
  if (!candidate) {
    return null;
  }
  const groupJid = normalizeWhatsAppGroupJid(candidate);
  if (groupJid) {
    return groupJid;
  }
  const newsletterMatch = candidate.match(WHATSAPP_NEWSLETTER_JID_RE);
  if (newsletterMatch) {
    return `${newsletterMatch[1]}@newsletter`;
  }
  const phone = extractUserJidPhone(candidate);
  if (phone) {
    const normalized = normalizeE164(phone);
    if (normalized.length <= 1) {
      return null;
    }
    return WHATSAPP_LID_RE.test(candidate) ? normalized : normalizeMexicanMobileE164(normalized);
  }
  if (candidate.includes("@")) {
    return null;
  }
  if (NON_WHATSAPP_PROVIDER_PREFIX_RE.test(candidate)) {
    return null;
  }
  const normalized = normalizeE164(candidate);
  return normalized.length > 1 ? normalizeMexicanMobileE164(normalized) : null;
}

export function normalizeWhatsAppMessagingTarget(raw: string): string | undefined {
  return isWhatsAppOwnerTarget(raw)
    ? WHATSAPP_OWNER_TARGET
    : (normalizeWhatsAppTarget(raw) ?? undefined);
}

export function normalizeWhatsAppAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return uniqueStrings(
    formatNormalizedAllowFromEntries({
      allowFrom,
      normalizeEntry: normalizeWhatsAppAllowFromEntry,
    }),
  );
}

export function normalizeWhatsAppAllowFromEntry(entry: string): string | null {
  if (entry === "*") {
    return entry;
  }
  const normalized = normalizeWhatsAppTarget(entry);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith("+") ? normalized.slice(1) : normalized;
}

export function looksLikeWhatsAppTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  return /^whatsapp:/i.test(trimmed) || normalizeWhatsAppMessagingTarget(trimmed) !== undefined;
}
