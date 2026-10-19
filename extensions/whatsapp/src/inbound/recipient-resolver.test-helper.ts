import { createWhatsAppRecipientResolver } from "./recipient-resolver.js";

/**
 * The production resolver over a fake WhatsApp: every number is registered under its own digits,
 * except the phone JIDs `registeredAs` maps to the JID WhatsApp reports for them.
 */
export function createTestWhatsAppRecipientResolver(
  registeredAs: Record<string, string> = {},
  authDir?: string,
) {
  return createWhatsAppRecipientResolver({
    authDir,
    lookup: async (phoneJid) => [{ jid: registeredAs[phoneJid] ?? phoneJid, exists: true }],
  });
}
