import type { z } from "zod";
import type {
  ChannelExecApprovalConfig,
  CommonChannelMessagingConfig,
} from "./types.channel-messaging-common.js";
import type { GroupToolPolicyBySenderConfig } from "./types.tools.js";
import type { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

type WhatsAppSchemaInput = z.input<typeof WhatsAppConfigSchema>;
type WhatsAppSchemaAccountConfig = NonNullable<
  NonNullable<WhatsAppSchemaInput["accounts"]>[string]
>;
type LegacyWhatsAppConfig = Pick<CommonChannelMessagingConfig, "dms" | "heartbeat"> & {
  /** @deprecated Doctor-only legacy input. */
  messagePrefix?: string;
};

type WhatsAppGroupSchemaInput = NonNullable<NonNullable<WhatsAppSchemaInput["groups"]>[string]>;
export type WhatsAppGroupConfig = Omit<WhatsAppGroupSchemaInput, "toolsBySender"> & {
  systemPrompt?: string;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};
export type WhatsAppDirectConfig = NonNullable<NonNullable<WhatsAppSchemaInput["direct"]>[string]>;
export type WhatsAppAckReactionConfig = {
  emoji?: string;
  direct?: boolean;
  group?: "always" | "mentions" | "never";
};

export type WhatsAppExecApprovalConfig = ChannelExecApprovalConfig<string> & {
  /**
   * Tell the chat a request came from that its approval went to approver DMs. Default: true.
   * A business turns it off when that chat is a customer's.
   */
  notifyOrigin?: boolean;
};

type WhatsAppNarrowedConfig = {
  groups?: Record<string, WhatsAppGroupConfig>;
  direct?: Record<string, WhatsAppDirectConfig>;
  ackReaction?: WhatsAppAckReactionConfig;
  execApprovals?: WhatsAppExecApprovalConfig;
};

export type WhatsAppAccountConfig = Omit<
  WhatsAppSchemaAccountConfig,
  keyof WhatsAppNarrowedConfig | keyof LegacyWhatsAppConfig
> &
  WhatsAppNarrowedConfig &
  LegacyWhatsAppConfig;

export type WhatsAppConfig = Omit<
  WhatsAppSchemaInput,
  "accounts" | keyof WhatsAppNarrowedConfig | keyof LegacyWhatsAppConfig
> &
  WhatsAppNarrowedConfig &
  LegacyWhatsAppConfig & {
    accounts?: Record<string, WhatsAppAccountConfig>;
  };

export type WhatsAppReactionLevel = NonNullable<WhatsAppConfig["reactionLevel"]>;
