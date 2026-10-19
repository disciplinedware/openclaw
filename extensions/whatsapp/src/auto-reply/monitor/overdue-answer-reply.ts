import type { ReplyDispatchKind } from "openclaw/plugin-sdk/reply-runtime";
import type { WhatsAppOverdueAnswer } from "../../overdue-answers.js";
import type { getChildLogger } from "./runtime-api.js";

/**
 * True when the person's answer is overdue as a reply leaves: the reply stays unsent, because only
 * the owner may be written to, and the log names the reason.
 */
export async function holdWhatsAppReplyForOverdueAnswer(params: {
  /** Set when the turn starts while the person's answer is overdue: nothing it produces reaches them. */
  overdueAnswer?: WhatsAppOverdueAnswer;
  /** Reads the person's overdue answer as a reply leaves, so a reply that comes too late stays unsent. */
  readOverdueAnswer?: () => Promise<WhatsAppOverdueAnswer | undefined>;
  replyLogger: ReturnType<typeof getChildLogger>;
  connectionId: string;
  conversationId: string;
  replyKind: ReplyDispatchKind;
}): Promise<boolean> {
  if (!(params.overdueAnswer ?? (await params.readOverdueAnswer?.()))) {
    return false;
  }
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      conversationId: params.conversationId,
      replyKind: params.replyKind,
    },
    "whatsapp: reply not sent; the answer is overdue and only the owner can be written to",
  );
  return true;
}
