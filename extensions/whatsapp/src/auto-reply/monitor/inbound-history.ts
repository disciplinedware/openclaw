import { buildInboundHistoryFromEntries } from "openclaw/plugin-sdk/reply-history";
import type { GroupHistoryEntry } from "./inbound-context.js";

/**
 * The history window of one inbound turn: a group's pending history, or a direct chat's
 * own messages as a platform-selected "recent" window.
 */
export function resolveWhatsAppInboundHistoryWindow(params: {
  conversationKind: "direct" | "group";
  groupHistory?: GroupHistoryEntry[];
  groupHistoryLimit?: number;
  directHistory?: GroupHistoryEntry[];
}) {
  const history = params.conversationKind === "group" ? params.groupHistory : params.directHistory;
  const inboundHistory =
    params.conversationKind === "group" || history?.length
      ? buildInboundHistoryFromEntries({
          entries: (history ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
            messageId: entry.id,
            media: entry.media,
          })),
          limit: history?.length ?? 1,
        })
      : undefined;
  const sessionTranscript =
    params.conversationKind === "group"
      ? { historyLimit: params.groupHistoryLimit ?? params.groupHistory?.length ?? 0 }
      : params.directHistory?.length
        ? // The window is exactly these messages; transcript rows must not merge into it.
          { historyLimit: params.directHistory.length, historyKind: "recent" as const }
        : { historyLimit: 0 };
  return { inboundHistory, sessionTranscript };
}
