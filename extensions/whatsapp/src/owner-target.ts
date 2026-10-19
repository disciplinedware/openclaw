import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { listWhatsAppCommandOwners } from "./command-owner.js";
import { isWhatsAppOwnerTarget, WHATSAPP_OWNER_TARGET } from "./normalize-target.js";

/** The one WhatsApp owner in `commands.ownerAllowFrom`, as E.164. The error names no number. */
function resolveWhatsAppOwnerE164(cfg: OpenClawConfig): string {
  const owners = listWhatsAppCommandOwners(cfg);
  const [owner] = owners;
  if (owners.length === 1 && owner) {
    return owner;
  }
  throw new Error(
    `WhatsApp target "${WHATSAPP_OWNER_TARGET}" needs exactly one WhatsApp owner in commands.ownerAllowFrom; ${
      owners.length === 0 ? "none is" : `${owners.length} are`
    } configured.`,
  );
}

/** The owner's E.164 when exactly one resolves, else undefined. */
export function findWhatsAppOwnerE164(cfg: OpenClawConfig): string | undefined {
  const owners = listWhatsAppCommandOwners(cfg);
  return owners.length === 1 ? owners[0] : undefined;
}

/** A send target as the transport uses it, and the redaction its results and errors need. */
export type WhatsAppSendTarget = {
  to: string;
  /** Replaces the owner's number and chat ids with `owner`; the identity for any other target. */
  redact: <T>(value: T) => T;
};

export function resolveWhatsAppSendTarget(to: string, cfg: OpenClawConfig): WhatsAppSendTarget {
  if (!isWhatsAppOwnerTarget(to)) {
    return { to, redact: (value) => value };
  }
  const ownerE164 = resolveWhatsAppOwnerE164(requireRuntimeConfig(cfg, "WhatsApp owner target"));
  return { to: ownerE164, redact: (value) => redactWhatsAppOwnerIdentity(value, ownerE164) };
}

/** Runs a send to the resolved target; its result and any error leave redacted. */
export async function sendToWhatsAppTarget<T>(
  target: WhatsAppSendTarget,
  send: (to: string) => Promise<T>,
): Promise<T> {
  try {
    return target.redact(await send(target.to));
  } catch (err) {
    throw target.redact(err);
  }
}

function buildOwnerIdentityPattern(ownerE164: string): RegExp {
  const digits = ownerE164.replace(/\D/g, "");
  // A send to the owner reaches one chat, so every chat id in its results is the owner's: its LID,
  // or the JID WhatsApp registered, whose digits can differ from the configured number.
  return new RegExp(
    `(?<!\\d)\\+?${digits}(?!\\d)(?::\\d+)?(?:@s\\.whatsapp\\.net|@c\\.us)?|(?<!\\d)\\d+(?::\\d+)?@(?:lid|s\\.whatsapp\\.net)\\b`,
    "g",
  );
}

/**
 * Returns `value` with every owner number and owner chat id replaced by `owner`. Plain data is
 * copied; an error is changed in place, so its class and identity survive for the caller.
 */
function redactWhatsAppOwnerIdentity<T>(value: T, ownerE164: string): T {
  const pattern = buildOwnerIdentityPattern(ownerE164);
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") {
      return current.replace(pattern, WHATSAPP_OWNER_TARGET);
    }
    if (!current || typeof current !== "object") {
      return current;
    }
    if (seen.has(current)) {
      return seen.get(current);
    }
    if (current instanceof Error) {
      seen.set(current, current);
      for (const key of new Set([...Object.keys(current), "message", "stack", "cause"])) {
        if (key in current) {
          // A read-only property keeps its value; the message and stack are writable.
          Reflect.set(current, key, visit(Reflect.get(current, key)));
        }
      }
      return current;
    }
    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      seen.set(current, copy);
      for (const item of current) {
        copy.push(visit(item));
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return current;
    }
    const copy: Record<string, unknown> = {};
    seen.set(current, copy);
    for (const [key, item] of Object.entries(current)) {
      copy[key] = visit(item);
    }
    return copy;
  };
  // SAFETY: visit keeps every value's shape; it only rewrites strings inside it.
  return visit(value) as T;
}
