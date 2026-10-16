import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./src/plugin-id.js";

function registerWhatsAppAgentSurface(api: OpenClawPluginApi): void {
  for (const exportName of ["registerWhatsAppAgentTools", "registerWhatsAppAgentSendHistory"]) {
    const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
      specifier: "./agent-tools-api.js",
      exportName,
    });
    register(api);
  }
}

export default defineBundledChannelEntry({
  id: WHATSAPP_FOR_BUSINESS_PLUGIN_ID,
  name: "WhatsApp for Business",
  description: "WhatsApp channel plugin with own messages and owner-only native approvals",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setWhatsAppRuntime",
  },
  registerFull: registerWhatsAppAgentSurface,
});
