import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import {
  jsonResult,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createChannelPartialDeliveryError,
  formatMediaPlaceholderText,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  buildOutboundSessionContext,
  sendDurableMessageBatch,
} from "openclaw/plugin-sdk/channel-outbound";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import { recordWhatsAppConversationMessage } from "./conversation-history.js";

const log = createSubsystemLogger("whatsapp/history");

export async function handleWhatsAppSendAction(ctx: ChannelMessageActionContext) {
  const { cfg, params } = ctx;
  const { to, accountId } = resolveAuthorizedWhatsAppOutboundTarget({
    cfg,
    chatJid: readStringParam(params, "to", { required: true }),
    accountId: ctx.accountId ?? undefined,
    actionLabel: "send",
  });
  const text = readStringParam(params, "message", { allowEmpty: true, trim: false }) ?? "";
  const mediaUrls = readStringArrayParam(params, "mediaUrls") ?? [];
  const mediaUrl = readStringParam(params, "media") ?? readStringParam(params, "mediaUrl");
  if (mediaUrl && !mediaUrls.includes(mediaUrl)) {
    mediaUrls.unshift(mediaUrl);
  }
  const mediaAccess = ctx.mediaAccess ?? {
    localRoots: ctx.mediaLocalRoots,
    readFile: ctx.mediaReadFile,
  };
  // Keep the originating session for hooks; the recipient's history is written below, after delivery.
  const session = buildOutboundSessionContext({
    cfg,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    requesterAccountId: ctx.requesterAccountId ?? accountId,
    requesterSenderId: ctx.requesterSenderId,
  });
  const send = await sendDurableMessageBatch({
    cfg,
    channel: "whatsapp",
    to,
    accountId,
    payloads: [
      {
        text,
        ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
        audioAsVoice:
          readBooleanParam(params, "asVoice") ?? readBooleanParam(params, "audioAsVoice"),
      },
    ],
    session,
    mediaAccess,
    ...(ctx.reply ? { reply: ctx.reply } : { replyToId: readStringParam(params, "replyTo") }),
    threadId: readStringOrNumberParam(params, "threadId"),
    gifPlayback: readBooleanParam(params, "gifPlayback"),
    forceDocument:
      readBooleanParam(params, "forceDocument") ?? readBooleanParam(params, "asDocument"),
    silent: readBooleanParam(params, "silent"),
    durability: "required",
    gatewayClientScopes: ctx.gatewayClientScopes,
    deliveryRetryOwner: ctx.deliveryRetryOwner,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    skipQueue: ctx.skipQueue,
  });
  if (send.status === "failed") {
    throw send.error;
  }
  if (send.status === "partial_failed") {
    throw createChannelPartialDeliveryError(send.error, {
      messageIds: send.results.map((result) => result.messageId),
      receipt: send.receipt,
      visibleReplySent: true,
    });
  }
  if (send.status === "suppressed") {
    return jsonResult({ status: "suppressed", reason: send.reason });
  }
  const messageId = send.receipt.primaryPlatformMessageId ?? send.results.at(-1)?.messageId;
  if (messageId) {
    // The message is delivered: a failed history write is logged, never reported as a failed send.
    await recordWhatsAppConversationMessage({
      cfg,
      accountId,
      peer: to,
      messageId,
      text: text || formatMediaPlaceholderText([{ kind: "unknown" }]),
      timestampMs: Date.now(),
      author: "agent",
      sourceSessionKey: ctx.sessionKey ?? undefined,
    }).catch((error: unknown) => {
      log.warn(
        `whatsapp history: delivered message ${messageId} is missing from the recipient's transcript: ${String(error)}`,
      );
    });
  }
  return jsonResult({
    ok: true,
    messageId,
    to,
    receipt: send.receipt,
  });
}
