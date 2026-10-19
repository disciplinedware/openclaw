import { readFileSync } from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./plugin-id.js";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Parameters<typeof validateJsonSchemaValue>[0]["schema"] };

/** Whether OpenClaw's startup validation accepts this plugin config. */
export function acceptsWhatsAppPluginConfig(value: unknown): boolean {
  return validateJsonSchemaValue({ schema: manifest.configSchema, value }).ok;
}

/** `plugins.entries.whatsapp-for-business.config` of a test config. */
export function whatsappPluginEntries(config: Record<string, unknown>) {
  return { entries: { [WHATSAPP_FOR_BUSINESS_PLUGIN_ID]: { config } } };
}
