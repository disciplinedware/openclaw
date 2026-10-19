import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { listWhatsAppAccountIds } from "./account-ids.js";
import { resolveWhatsAppGroupSessionKey } from "./group-session-key.js";
import { normalizeWhatsAppTarget } from "./normalize-target.js";

export function resolveWhatsAppOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  // `owner` gets no route: its session key would carry the owner's number back to core.
  const normalized = normalizeWhatsAppTarget(params.target);
  if (!normalized) {
    return null;
  }
  const isGroup = normalized.endsWith("@g.us");
  const isNewsletter = normalized.endsWith("@newsletter");
  const chatType = isGroup ? "group" : isNewsletter ? "channel" : "direct";
  const route = buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "whatsapp",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: {
      kind: chatType,
      id: normalized,
    },
    chatType,
    from: normalized,
    to: normalized,
  });
  return isGroup
    ? {
        ...route,
        sessionKey: resolveWhatsAppGroupSessionKey({
          sessionKey: route.sessionKey,
          accountId: params.accountId,
        }),
      }
    : route;
}

/** The session key, lowercased, of one person's direct chat on one account, as inbound routes it. */
export function resolveWhatsAppDirectSessionKey(params: {
  cfg: OpenClawConfig;
  accountId: string;
  peerE164: string;
}): string {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: { kind: "direct", id: params.peerE164 },
  }).sessionKey.toLowerCase();
}

/** The accounts on which `sessionKey` is the owner's direct chat. */
export function listWhatsAppOwnerSessionAccounts(params: {
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
  ownerE164: string;
}): string[] {
  const sessionKey = params.sessionKey?.trim().toLowerCase();
  if (!sessionKey) {
    return [];
  }
  return listWhatsAppAccountIds(params.cfg).filter(
    (accountId) =>
      resolveWhatsAppDirectSessionKey({
        cfg: params.cfg,
        accountId,
        peerE164: params.ownerE164,
      }) === sessionKey,
  );
}
