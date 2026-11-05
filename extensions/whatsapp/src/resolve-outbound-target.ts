import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listWhatsAppCommandOwners } from "./command-owner.js";
import {
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
  WHATSAPP_OWNER_TARGET,
} from "./normalize-target.js";

const WHATSAPP_TARGET_HINT = `<E.164|group JID|newsletter JID|${WHATSAPP_OWNER_TARGET}>`;

type WhatsAppOutboundTargetResolution = { ok: true; to: string } | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  cfg?: OpenClawConfig;
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const target = normalizeWhatsAppMessagingTarget(params.to ?? "");
  if (target === WHATSAPP_OWNER_TARGET) {
    // The owner is the command owner, admitted whatever allowFrom says.
    const owners = params.cfg ? listWhatsAppCommandOwners(params.cfg) : [];
    const [owner] = owners;
    return owners.length === 1 && owner
      ? { ok: true, to: owner }
      : {
          ok: false,
          error: new Error(
            `WhatsApp target "${WHATSAPP_OWNER_TARGET}" needs exactly one WhatsApp owner in commands.ownerAllowFrom; ${owners.length} configured.`,
          ),
        };
  }
  const normalizedTo = target && normalizeWhatsAppTarget(target);
  if (!normalizedTo) {
    return {
      ok: false,
      error: missingTargetError("WhatsApp", WHATSAPP_TARGET_HINT),
    };
  }
  if (normalizedTo.endsWith("@g.us") || normalizedTo.endsWith("@newsletter")) {
    return { ok: true, to: normalizedTo };
  }

  const allowListRaw = normalizeStringEntries(params.allowFrom ?? []);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (hasWildcard || allowList.length === 0 || allowList.includes(normalizedTo)) {
    return { ok: true, to: normalizedTo };
  }
  return {
    ok: false,
    error: new Error(
      `Target "${normalizedTo}" is not listed in the configured WhatsApp allowFrom policy.`,
    ),
  };
}
