// Writes channelConfigs.whatsapp of openclaw.plugin.json from the plugin-local schema.
// A stock host validates `channels.whatsapp` with this entry before plugin code runs.
// Usage (repository root): node --import ./scripts/tsx.mjs extensions/whatsapp/scripts/write-channel-config-schema.mts [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWhatsAppChannelConfigsManifestEntry } from "../src/config-schema.js";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const serialized = `${JSON.stringify(
  { ...manifest, channelConfigs: { whatsapp: buildWhatsAppChannelConfigsManifestEntry() } },
  null,
  2,
)}\n`;

if (process.argv.includes("--check")) {
  if (serialized !== readFileSync(manifestPath, "utf8")) {
    console.error("openclaw.plugin.json channelConfigs is stale; rerun without --check.");
    process.exit(1);
  }
} else {
  writeFileSync(manifestPath, serialized);
}
