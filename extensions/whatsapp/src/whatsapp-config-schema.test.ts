import { readFileSync } from "node:fs";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { describe, expect, it } from "vitest";
import { buildWhatsAppChannelConfigsManifestEntry } from "./config-schema.js";
import { WhatsAppConfigSchema } from "./whatsapp-config-schema.js";

describe("whatsapp plugin-local config schema", () => {
  it("equals the core WhatsApp schema", async () => {
    // Test-only read of the host's bundled schema: the plugin itself never imports this subpath.
    const upstream = (await import("openclaw/plugin-sdk/bundled-channel-config-schema")) as {
      WhatsAppConfigSchema: Parameters<typeof buildChannelConfigSchema>[0];
    };
    const ours = buildChannelConfigSchema(WhatsAppConfigSchema).schema;
    const theirs = buildChannelConfigSchema(upstream.WhatsAppConfigSchema).schema;

    expect(ours).toStrictEqual(theirs);
  });

  it("keeps openclaw.plugin.json channelConfigs in sync with the source schema", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { channelConfigs?: Record<string, unknown> };

    // JSON drops undefined members, so compare with toEqual rather than toStrictEqual.
    expect(manifest.channelConfigs?.whatsapp).toEqual(buildWhatsAppChannelConfigsManifestEntry());
  });
});
