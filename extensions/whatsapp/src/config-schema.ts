import { buildChannelConfigSchema, WhatsAppConfigSchema } from "../config-api.js";
import { whatsAppChannelConfigUiHints } from "./config-ui-hints.js";

export const WhatsAppChannelConfigSchema = buildChannelConfigSchema(WhatsAppConfigSchema, {
  uiHints: whatsAppChannelConfigUiHints,
});

/** The stock plugin that this package replaces under the same channel id. */
const WHATSAPP_STOCK_PLUGIN_ID = "whatsapp";

/** Manifest `channelConfigs.whatsapp`; OpenClaw validates `channels.whatsapp` with it. */
export function buildWhatsAppChannelConfigsManifestEntry() {
  return {
    schema: WhatsAppChannelConfigSchema.schema,
    uiHints: WhatsAppChannelConfigSchema.uiHints,
    label: "WhatsApp",
    description: "WhatsApp Web chats through a linked device.",
    preferOver: [WHATSAPP_STOCK_PLUGIN_ID],
  };
}
