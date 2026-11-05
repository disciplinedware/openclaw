import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { WHATSAPP_FOR_BUSINESS_PLUGIN_ID } from "./src/plugin-id.js";

function registerWhatsAppAgentTools(api: OpenClawPluginApi): void {
  const registerTool = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
    import.meta.url,
    {
      specifier: "./agent-tools-api.js",
      exportName: "registerWhatsAppAgentTools",
    },
  );
  registerTool(api);
}

export default defineBundledChannelEntry({
  id: WHATSAPP_FOR_BUSINESS_PLUGIN_ID,
  name: "WhatsApp for Business",
  description:
    "WhatsApp channel plugin with message approvals that only the owner resolves, a message card and the owner target",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setWhatsAppRuntime",
  },
  registerFull(api) {
    registerWhatsAppAgentTools(api);
  },
});
