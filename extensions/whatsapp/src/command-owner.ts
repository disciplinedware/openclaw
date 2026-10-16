import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeWhatsAppTarget } from "./normalize-target.js";

/** A person's WhatsApp id as E.164. Groups, newsletters and other channels' ids are none. */
export function normalizeWhatsAppDirectId(value: string | number): string | undefined {
  const normalized = normalizeWhatsAppTarget(String(value));
  return normalized?.startsWith("+") ? normalized : undefined;
}

/**
 * The WhatsApp command owners: the entries of `commands.ownerAllowFrom` that are
 * `whatsapp:+<number>` or a bare number, as E.164, in config order.
 */
export function listWhatsAppCommandOwners(cfg: OpenClawConfig): string[] {
  const ownerAllowFrom = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(ownerAllowFrom)) {
    return [];
  }
  return uniqueStrings(
    ownerAllowFrom
      .map((entry) => normalizeWhatsAppDirectId(entry))
      .filter((owner): owner is string => Boolean(owner)),
  );
}
