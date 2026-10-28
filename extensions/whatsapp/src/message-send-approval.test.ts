import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeConfig = vi.hoisted(() => ({ current: {} as OpenClawConfig }));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),

  getRuntimeConfig: () => runtimeConfig.current,
}));

import { whatsappPlugin } from "./channel.js";

const payload = {
  text: "The original message stays intact.",
  mediaUrl: "https://example.com/photo.jpg",
  mediaUrls: ["https://example.com/photo.jpg"],
  channelData: { whatsapp: { quotedMessageId: "quoted-1" } },
};

function prepare(requestApproval?: unknown, replyContext?: string) {
  const callback = whatsappPlugin.actions?.prepareSendPayload;
  if (!callback) {
    throw new Error("WhatsApp send-payload preparation is not registered.");
  }
  return callback({
    ctx: {
      action: "send",
      params: {
        ...(requestApproval === undefined ? {} : { requestApproval }),
        ...(replyContext === undefined ? {} : { replyContext }),
      },
    } as Parameters<typeof callback>[0]["ctx"],
    to: "+15550000300",
    payload,
  });
}

afterEach(() => {
  runtimeConfig.current = {};
});

describe("WhatsApp message-send approval request", () => {
  it("declares a blocking default for requests with no approval policy", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, unknown> } };

    expect(manifest.configSchema.properties.unhandledApprovalPolicy).toMatchObject({
      type: "string",
      enum: ["block", "send"],
      default: "block",
    });
  });

  it("advertises the optional request flag for configured cross-chat sends", () => {
    const discovery = whatsappPlugin.actions?.describeMessageTool({
      cfg: { channels: { whatsapp: {} } } as OpenClawConfig,
    });
    const schema = discovery?.schema;
    const contribution = Array.isArray(schema) ? schema[0] : schema;

    expect(contribution).toMatchObject({
      actions: ["send"],
      visibility: "all-configured",
    });
    expect(contribution?.properties?.requestApproval).toMatchObject({
      type: "boolean",
      description: expect.stringContaining("Set to true when a human must approve this message."),
    });
    const requestApproval = contribution?.properties?.requestApproval;
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("Keep target as the intended recipient"),
    );
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("message as the exact proposed reply"),
    );
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("Omit for ordinary sends"),
    );
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("a policy may still require approval"),
    );
    expect(requestApproval).toHaveProperty(
      "description",
      expect.stringContaining("This flag does not approve delivery."),
    );
  });

  it("blocks a flagged send under the default and explicit block policy", () => {
    runtimeConfig.current = {};
    expect(() => prepare(true)).toThrow(/approval policy did not process it/);

    runtimeConfig.current = {
      plugins: {
        entries: {
          "whatsapp-for-business": { config: { unhandledApprovalPolicy: "block" } },
        },
      },
    } as OpenClawConfig;
    expect(() => prepare(true)).toThrow(/approval policy did not process it/);
  });

  it("advertises replyContext for sends and reactions without making ordinary sends require it", () => {
    const discovery = whatsappPlugin.actions?.describeMessageTool({
      cfg: { channels: { whatsapp: {} } } as OpenClawConfig,
    });
    const contributions = Array.isArray(discovery?.schema) ? discovery.schema : [discovery?.schema];
    const contribution = contributions.find((entry) => entry?.properties?.replyContext);
    expect(contribution).toMatchObject({
      actions: ["send", "react"],
      visibility: "all-configured",
    });
    expect(contribution?.properties?.replyContext).toMatchObject({
      type: "string",
      description: expect.stringContaining(
        "It must be a nonempty string when approval is required.",
      ),
    });
    expect(contribution?.properties?.replyContext).toHaveProperty(
      "description",
      expect.stringContaining("not a quotation, permission or text to send"),
    );
    expect(prepare()).toBe(payload);
  });

  it("never appends replyContext to the delivered text or media", () => {
    expect(prepare(false, "The person asks for the call time and the meeting link.")).toBe(payload);
    expect(payload.text).toBe("The original message stays intact.");
    expect(payload).not.toHaveProperty("replyContext");
  });

  it("passes the same text and media payload when policy clears the request", () => {
    runtimeConfig.current = {};
    expect(prepare(false)).toBe(payload);
    expect(prepare(undefined)).toBe(payload);
  });

  it("passes the unchanged payload only when the operator permits unhandled requests", () => {
    runtimeConfig.current = {
      plugins: {
        entries: {
          "whatsapp-for-business": { config: { unhandledApprovalPolicy: "send" } },
        },
      },
    } as OpenClawConfig;

    expect(prepare(true)).toBe(payload);
    expect(payload).toEqual({
      text: "The original message stays intact.",
      mediaUrl: "https://example.com/photo.jpg",
      mediaUrls: ["https://example.com/photo.jpg"],
      channelData: { whatsapp: { quotedMessageId: "quoted-1" } },
    });
  });

  it("rejects a malformed flag even when the operator permits unhandled requests", () => {
    runtimeConfig.current = {
      plugins: {
        entries: {
          "whatsapp-for-business": { config: { unhandledApprovalPolicy: "send" } },
        },
      },
    } as OpenClawConfig;

    expect(() => prepare("true")).toThrow("requestApproval must be a boolean");
  });
});
