import type { WAMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeWhatsAppDirectId } from "../command-owner.js";
import {
  readWhatsAppOverdueAnswer,
  recordWhatsAppAnswer,
  recordWhatsAppUnansweredMessage,
  resolveWhatsAppAnswerPerson,
  type WhatsAppOverdueAnswer,
} from "../overdue-answers.js";
import { requireWhatsAppInboundAdmission, type WhatsAppInboundAdmission } from "./admission.js";
import { hasInboundUserContent } from "./extract.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";

/** The parts of an inbound message that name the person it tracks. */
type WhatsAppAnswerTrackedMessage = {
  admission?: WhatsAppInboundAdmission;
  event: { id?: string; timestamp?: number };
  platform: { senderE164?: string };
  ownMessage?: unknown;
};

/**
 * Keeps one account's overdue-answer state (`overdue-answers.ts`) in step with what arrives: a
 * person's message waits for an answer; a message the linked phone or another device of the
 * account sent to the person's chat answers it. The plugin's own sends are recorded where they
 * leave (`socket-session.ts`).
 */
export function createWhatsAppAnswerTracker(deps: {
  accountId: string;
  getRuntimeConfig: () => OpenClawConfig;
  resolveInboundJid: WhatsAppAttachedSocketSession["resolveInboundJid"];
  parseTimestampSeconds: (value: unknown) => number | undefined;
}) {
  const resolvePerson = (message: WhatsAppAnswerTrackedMessage) =>
    resolveWhatsAppAnswerPerson({
      admission: requireWhatsAppInboundAdmission(message),
      senderE164: message.platform.senderE164,
      isOwnMessageTurn: message.ownMessage !== undefined,
      cfg: deps.getRuntimeConfig(),
    });

  /** Records a person's message before its turn can start, so the turn and the send guard see it. */
  const recordPersonMessage = async (message: WhatsAppAnswerTrackedMessage): Promise<void> => {
    const person = resolvePerson(message);
    if (person) {
      await recordWhatsAppUnansweredMessage(person, {
        ...(message.event.id ? { id: message.event.id } : {}),
        ...(message.event.timestamp !== undefined ? { sentAtMs: message.event.timestamp } : {}),
        receivedAtMs: Date.now(),
      });
    }
  };

  /** The overdue answer of the person a message tracks, now; none for a message that tracks no one. */
  const readOverdueAnswer = async (
    message: WhatsAppAnswerTrackedMessage | undefined,
  ): Promise<WhatsAppOverdueAnswer | undefined> => {
    const person = message ? resolvePerson(message) : undefined;
    return person ? await readWhatsAppOverdueAnswer(person, Date.now()) : undefined;
  };

  /** Records a message the account sent from another device to a person's chat as an answer. */
  const recordLinkedDeviceAnswer = async (msg: WAMessage, receivedAt: number): Promise<void> => {
    const remoteJid = msg.key?.remoteJid;
    if (
      msg.key?.fromMe !== true ||
      !remoteJid ||
      !hasInboundUserContent(msg.message ?? undefined)
    ) {
      return;
    }
    // Groups, status and broadcast chats are no person.
    const personE164 = normalizeWhatsAppDirectId(
      (await deps.resolveInboundJid(remoteJid)) ?? remoteJid,
    );
    if (!personE164) {
      return;
    }
    const sentAtSeconds = deps.parseTimestampSeconds(msg.messageTimestamp);
    await recordWhatsAppAnswer(
      { accountId: deps.accountId, personE164 },
      sentAtSeconds !== undefined ? sentAtSeconds * 1000 : receivedAt,
    );
  };

  return { recordPersonMessage, readOverdueAnswer, recordLinkedDeviceAnswer } as const;
}
