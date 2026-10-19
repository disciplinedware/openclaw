import { isReplaySafeToolCall } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listWhatsAppAccountIds } from "./account-ids.js";
import { getActiveWebListener } from "./active-listener.js";
import { WHATSAPP_CALL_TOOL_NAME } from "./agent-tools-call.js";
import { normalizeWhatsAppDirectId } from "./command-owner.js";
import { isWhatsAppOwnerTarget, normalizeWhatsAppTarget } from "./normalize-target.js";
import {
  describeWhatsAppOverdueAnswerRule,
  formatWhatsAppOverdueSince,
  listWhatsAppOverdueAnswers,
  readWhatsAppOverdueAnswer,
  recordWhatsAppTurnSend,
} from "./overdue-answers.js";
import { findWhatsAppOwnerE164 } from "./owner-target.js";
import {
  listWhatsAppOwnerSessionAccounts,
  resolveWhatsAppDirectSessionKey,
} from "./session-route.js";

/** The parts of OpenClaw's `before_tool_call` event that this module reads. */
type WhatsAppToolCall = {
  toolName: string;
  params: Record<string, unknown>;
};

/** The parts of OpenClaw's tool hook context that this module reads. */
type WhatsAppToolCallContext = {
  sessionKey?: string;
  /** The run's current conversation id. */
  channelId?: string;
  requester?: { channel?: string; accountId?: string; senderId?: string };
};

/**
 * Whom on WhatsApp a call reaches. `people` are E.164 numbers other than the owner; `isUnknown` is
 * set when a target cannot be read as a person, a group, a newsletter or the owner.
 */
type WhatsAppToolCallReach = { people: string[]; isUnknown: boolean };

/** The raw targets of a `message` call; none means the current chat. */
function readMessageTargets(params: Record<string, unknown>): string[] {
  const candidates = [
    // OpenClaw's canonical target keys (`message-action-routing.ts`).
    params.target,
    params.to,
    params.channelId,
    // The reaction's chat (`messageActionTargetAliases` in channel.ts).
    params.chatJid,
    ...(Array.isArray(params.targets) ? params.targets : []),
  ];
  return candidates.flatMap((value) => {
    const target = normalizeOptionalString(value);
    return target ? [target] : [];
  });
}

function addTarget(reach: WhatsAppToolCallReach, raw: string, ownerE164: string | undefined) {
  if (isWhatsAppOwnerTarget(raw)) {
    return;
  }
  const normalized = normalizeWhatsAppTarget(raw);
  if (!normalized) {
    reach.isUnknown = true;
    return;
  }
  const person = normalizeWhatsAppDirectId(normalized);
  if (person && person !== ownerE164 && !reach.people.includes(person)) {
    reach.people.push(person);
  }
}

/**
 * True when the call puts something in front of anyone on WhatsApp, the owner included: a voice
 * call, or a WhatsApp `message` call that is not a known read-only action (OpenClaw's
 * `isReplaySafeToolCall`). A call without a channel goes to the run's channel; a run without one
 * counts as WhatsApp.
 */
function isWhatsAppReachingCall(call: WhatsAppToolCall, context: WhatsAppToolCallContext): boolean {
  if (call.toolName === WHATSAPP_CALL_TOOL_NAME) {
    return normalizeOptionalString(call.params.action) === "call";
  }
  if (call.toolName !== "message") {
    return false;
  }
  const channel =
    normalizeOptionalString(call.params.channel) ??
    normalizeOptionalString(context.requester?.channel);
  return (
    (!channel || channel.toLowerCase() === "whatsapp") &&
    !isReplaySafeToolCall("message", call.params)
  );
}

/**
 * Whom a reaching call may put something in front of on WhatsApp: a voice call reaches the run's
 * requester; a `message` call reaches its targets, or the current chat when it names none. A
 * missing, unknown or future `message` action counts as one that reaches.
 */
function readWhatsAppToolCallReach(params: {
  call: WhatsAppToolCall;
  context: WhatsAppToolCallContext;
  ownerE164: string | undefined;
}): WhatsAppToolCallReach {
  const reach: WhatsAppToolCallReach = { people: [], isUnknown: false };
  const { call, context } = params;
  if (!isWhatsAppReachingCall(call, context)) {
    return reach;
  }
  if (call.toolName === WHATSAPP_CALL_TOOL_NAME) {
    const requester = normalizeOptionalString(context.requester?.senderId);
    if (requester) {
      addTarget(reach, requester, params.ownerE164);
    } else {
      reach.isUnknown = true;
    }
    return reach;
  }
  const targets = readMessageTargets(call.params);
  const currentChat = normalizeOptionalString(context.channelId);
  if (targets.length === 0 && !currentChat) {
    reach.isUnknown = true;
  }
  for (const target of targets.length > 0 ? targets : currentChat ? [currentChat] : []) {
    addTarget(reach, target, params.ownerE164);
  }
  return reach;
}

/**
 * True when the run is the owner's: its session is the owner's direct chat and not also the
 * person's. Under `session.dmScope: "main"` every direct chat shares one session, where a person's
 * message can join the owner's run, so no run counts as the owner's there.
 */
function isOwnerRunFor(params: {
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
  ownerE164: string | undefined;
  personE164: string;
}): boolean {
  if (!params.ownerE164) {
    return false;
  }
  const sessionKey = params.sessionKey?.trim().toLowerCase();
  return listWhatsAppOwnerSessionAccounts({
    cfg: params.cfg,
    sessionKey,
    ownerE164: params.ownerE164,
  }).some(
    (accountId) =>
      resolveWhatsAppDirectSessionKey({
        cfg: params.cfg,
        accountId,
        peerE164: params.personE164,
      }) !== sessionKey,
  );
}

type WhatsAppToolBlock = { block: true; blockReason: string };

const UNRESOLVED = Symbol("unresolved");

/**
 * The person a number reaches on an account, as WhatsApp registers the number: the form inbound
 * messages and the overdue-answer state use. `undefined` when WhatsApp has no account for the
 * number, because the send itself refuses then. `UNRESOLVED` when the account has no live
 * connection or WhatsApp did not answer, because then the person cannot be known.
 */
async function resolveRegisteredPerson(
  accountId: string,
  e164: string,
): Promise<string | undefined | typeof UNRESOLVED> {
  const recipients = getActiveWebListener(accountId)?.recipients;
  if (!recipients) {
    return UNRESOLVED;
  }
  try {
    return await recipients.resolveE164(e164);
  } catch (error) {
    return error instanceof PlatformMessageNotDispatchedError && !error.retryable
      ? undefined
      : UNRESOLVED;
  }
}

/**
 * Refuses a tool call that would reach a person whose answer is overdue (`overdue-answers.ts`):
 * only the owner may be written to then. The owner's own run passes, because the owner decided.
 * A call whose recipient cannot be read or resolved is refused while any person's answer on the
 * account is overdue.
 */
async function resolveWhatsAppOverdueAnswerToolBlock(params: {
  call: WhatsAppToolCall;
  context: WhatsAppToolCallContext;
  cfg: OpenClawConfig;
  nowMs: number;
}): Promise<WhatsAppToolBlock | undefined> {
  const ownerE164 = findWhatsAppOwnerE164(params.cfg);
  const reach = readWhatsAppToolCallReach({
    call: params.call,
    context: params.context,
    ownerE164,
  });
  // The account the send goes through: the call's, else the run's; when unknown, every account.
  const sendingAccountId =
    normalizeOptionalString(params.call.params.accountId) ??
    normalizeOptionalString(params.context.requester?.accountId);
  const accountIds = sendingAccountId ? [sendingAccountId] : listWhatsAppAccountIds(params.cfg);
  for (const accountId of accountIds) {
    let isUnknown = reach.isUnknown;
    for (const target of reach.people) {
      const personE164 = await resolveRegisteredPerson(accountId, target);
      if (personE164 === UNRESOLVED) {
        isUnknown = true;
        continue;
      }
      if (
        !personE164 ||
        personE164 === ownerE164 ||
        isOwnerRunFor({
          cfg: params.cfg,
          sessionKey: params.context.sessionKey,
          ownerE164,
          personE164,
        })
      ) {
        continue;
      }
      const overdue = await readWhatsAppOverdueAnswer({ accountId, personE164 }, params.nowMs);
      if (overdue) {
        return {
          block: true,
          blockReason: `WhatsApp ${personE164}: ${describeWhatsAppOverdueAnswerRule(overdue)}`,
        };
      }
    }
    if (!isUnknown) {
      continue;
    }
    const overdue = (await listWhatsAppOverdueAnswers(params.nowMs)).find(
      (entry) => entry.accountId === accountId,
    );
    if (overdue) {
      return {
        block: true,
        blockReason:
          `WhatsApp: this call names a recipient that cannot be read as a number or checked with ` +
          `WhatsApp now, while the answer to ${overdue.personE164} is overdue (waiting since ` +
          `${formatWhatsAppOverdueSince(overdue.overdue)}). Name the recipient by number and ` +
          `retry; for an overdue answer only the owner can be written to (message target "owner").`,
      };
    }
  }
  return undefined;
}

export function registerWhatsAppOverdueAnswerSendGuard(api: OpenClawPluginApi): void {
  api.on("before_tool_call", async (event, ctx) => {
    if (!isWhatsAppReachingCall(event, ctx)) {
      return undefined;
    }
    // Only a run a person's message started ends in a turn end that takes this record.
    if (ctx.sessionKey && ctx.requester?.senderId) {
      recordWhatsAppTurnSend(ctx.sessionKey);
    }
    return await resolveWhatsAppOverdueAnswerToolBlock({
      call: event,
      context: ctx,
      cfg: getRuntimeConfig(),
      nowMs: Date.now(),
    });
  });
}
