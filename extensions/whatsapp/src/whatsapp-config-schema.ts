// Plugin-local copy of src/config/zod-schema.providers-whatsapp.ts for the npm package: a
// third-party plugin defines its own schema (plugin-sdk/bundled-channel-config-schema), and a
// stock host's bundled copy lacks execApprovals and ownMessages. whatsapp-config-schema.test.ts
// keeps both equal.
import {
  buildChannelAccountSchemaParts,
  buildChannelExecApprovalsSchema,
  buildChannelReactionShape,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { z } from "zod";

const WhatsAppGroupEntrySchema = buildGroupEntrySchema(undefined, {
  omit: ["skills", "enabled", "allowFrom"],
}).optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppDirectEntrySchema = z
  .strictObject({
    systemPrompt: z.string().optional(),
  })
  .optional();

const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();

const WhatsAppPluginHooksSchema = z
  .strictObject({
    messageReceived: z.boolean().optional(),
  })
  .optional();

/** A phone number in E.164 form: "+", country code, subscriber number, 15 digits at most. */
const WhatsAppE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "expected an E.164 phone number such as +15550001234");

const { accountShape, rootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["name"],
  allowFrom: z.array(z.string()).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

const WhatsAppCommonShape = {
  ...accountShape,
  sendReadReceipts: ChannelSendReadReceiptsSchema,
  selfChatMode: z.boolean().optional(),
  groups: WhatsAppGroupsSchema,
  direct: WhatsAppDirectSchema,
  ...buildChannelReactionShape({
    reactionLevels: ["off", "ack", "minimal", "extensive"],
  }),
  pluginHooks: WhatsAppPluginHooksSchema,
  execApprovals: buildChannelExecApprovalsSchema(WhatsAppE164Schema, {
    notifyOrigin: z.boolean().optional(),
  }),
  ownMessages: z.enum(["off", "history", "turn"]).optional(),
};

const WhatsAppAccountSchema = z.strictObject({
  ...WhatsAppCommonShape,
  name: z.string().optional(),
  /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
  authDir: z.string().optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

export const WhatsAppConfigSchema = z
  .strictObject({
    ...WhatsAppCommonShape,
    ...rootPolicyShape,
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    actions: z
      .strictObject({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        polls: z.boolean().optional(),
        calls: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const defaultAccount = resolveAccountEntry(value.accounts, "default");
    refineChannelDmPolicy({ channelId: "whatsapp", value, ctx });
    // Named accounts inherit the default account before the channel root.
    const inherited = {
      ...value,
      dmPolicy: defaultAccount?.dmPolicy ?? value.dmPolicy,
      allowFrom: defaultAccount?.allowFrom ?? value.allowFrom,
    };
    for (const accountId of Object.keys(value.accounts ?? {})) {
      refineChannelDmPolicy({
        channelId: "whatsapp",
        value: accountId === "default" ? value : inherited,
        accountId,
        ctx,
      });
    }
  });
