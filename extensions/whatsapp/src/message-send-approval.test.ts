import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("WhatsApp message-send approval request", () => {
  it("advertises the optional requestApproval flag on send for configured accounts", () => {
    const discovery = whatsappPlugin.actions?.describeMessageTool({
      cfg: { channels: { whatsapp: {} } } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    const contributions = Array.isArray(schema) ? schema : [schema];

    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({ actions: ["send"], visibility: "all-configured" });
    const requestApproval = contributions[0]?.properties?.requestApproval;
    expect(requestApproval).toMatchObject({ type: "boolean" });
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("Set to true when a human must approve this message"),
    );
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("This flag does not approve delivery."),
    );
  });

  it("leaves the send payload to core: the flag is an argument the approval policy reads", () => {
    expect(whatsappPlugin.actions?.prepareSendPayload).toBeUndefined();
  });
});
