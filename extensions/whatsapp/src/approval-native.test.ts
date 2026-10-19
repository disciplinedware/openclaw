import { describe, expect, it } from "vitest";
import { whatsappApprovalCapability } from "./approval-native.js";

const BUSINESS = "+15550000100";
const OWNER = "+15550000200";
const CONTACT = "+15550000300";

function buildConfig(
  whatsapp: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): never {
  return {
    channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"], ...whatsapp } },
    ...extra,
  } as never;
}

function contactTurnSource() {
  return {
    agentId: "main",
    sessionKey: `agent:main:whatsapp:direct:${CONTACT}`,
    turnSourceChannel: "whatsapp",
    turnSourceTo: CONTACT,
    turnSourceAccountId: "default",
  };
}

function pluginRequest() {
  return {
    id: "plugin:approval-1",
    request: {
      pluginId: "acs",
      title: "Send a payment link",
      description: "The contact asks for a payment link.",
      allowedDecisions: ["allow-once", "deny"],
      ...contactTurnSource(),
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  } as never;
}

function execRequest() {
  return {
    id: "exec-1",
    request: {
      command: "echo hi",
      cwd: "/tmp/work",
      host: "gateway",
      ask: "always",
      ...contactTurnSource(),
    },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  } as never;
}

const native = whatsappApprovalCapability.native!;

function deliveryPlan(cfg: never, approvalKind: "exec" | "plugin" = "plugin") {
  const request = approvalKind === "plugin" ? pluginRequest() : execRequest();
  const input = { cfg, accountId: "default", approvalKind, request };
  return {
    capabilities: native.describeDeliveryCapabilities(input),
    origin: native.resolveOriginTarget?.(input) ?? null,
    approverDms: native.resolveApproverDmTargets?.(input) ?? [],
  };
}

describe("whatsapp native approval delivery", () => {
  it.each(["exec", "plugin"] as const)(
    "sends a %s approval from a contact chat to the approver's DM only",
    async (approvalKind) => {
      const plan = deliveryPlan(
        buildConfig({ execApprovals: { approvers: [OWNER] } }),
        approvalKind,
      );

      expect(plan.capabilities).toEqual({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      });
      expect(await plan.approverDms).toEqual([{ to: OWNER }]);
    },
  );

  it("keeps the origin chat silent with notifyOrigin false while the approver still gets the prompt", async () => {
    const plan = deliveryPlan(
      buildConfig({ execApprovals: { approvers: [OWNER], notifyOrigin: false } }),
    );

    expect(plan.capabilities).toMatchObject({
      enabled: true,
      preferredSurface: "approver-dm",
      notifyOriginWhenDmOnly: false,
    });
    expect(await plan.approverDms).toEqual([{ to: OWNER }]);
  });

  it("reads notifyOrigin per account", () => {
    const cfg = buildConfig({
      execApprovals: { approvers: [OWNER] },
      accounts: { biz: { execApprovals: { approvers: [OWNER], notifyOrigin: false } } },
    });
    const notifies = (accountId: string) =>
      native.describeDeliveryCapabilities({
        cfg,
        accountId,
        approvalKind: "plugin",
        request: pluginRequest(),
      }).notifyOriginWhenDmOnly;

    expect(notifies("default")).toBe(true);
    expect(notifies("biz")).toBe(false);
  });

  it("takes the approver from the WhatsApp entries of commands.ownerAllowFrom", async () => {
    const plan = deliveryPlan(
      buildConfig(
        {},
        { commands: { ownerAllowFrom: ["telegram:123456789", `whatsapp:${OWNER}`] } },
      ),
    );

    expect(plan.capabilities.enabled).toBe(true);
    expect(await plan.approverDms).toEqual([{ to: OWNER }]);
  });

  it("prefers execApprovals.approvers over commands.ownerAllowFrom", async () => {
    const plan = deliveryPlan(
      buildConfig(
        { execApprovals: { approvers: [OWNER] } },
        { commands: { ownerAllowFrom: [`whatsapp:${BUSINESS}`] } },
      ),
    );

    expect(await plan.approverDms).toEqual([{ to: OWNER }]);
  });

  it("never takes an approver from allowFrom", async () => {
    const cfg = buildConfig({ allowFrom: [OWNER, CONTACT] });
    const plan = deliveryPlan(cfg);

    expect(plan.capabilities.enabled).toBe(false);
    expect(await plan.approverDms).toEqual([]);
    expect(whatsappApprovalCapability.delivery?.hasConfiguredDmRoute?.({ cfg })).toBe(false);
  });

  it("is off with enabled false even when approvers resolve", async () => {
    const plan = deliveryPlan(
      buildConfig({ execApprovals: { enabled: false, approvers: [OWNER] } }),
    );

    expect(plan.capabilities.enabled).toBe(false);
    expect(await plan.approverDms).toEqual([]);
  });

  it("sends to the originating chat with target channel", async () => {
    const plan = deliveryPlan(
      buildConfig({ execApprovals: { approvers: [OWNER], target: "channel" } }),
    );

    expect(plan.capabilities.preferredSurface).toBe("origin");
    expect(await plan.origin).toMatchObject({ to: CONTACT });
  });

  it("applies the agent filter", async () => {
    const plan = deliveryPlan(
      buildConfig({ execApprovals: { approvers: [OWNER], agentFilter: ["ops"] } }),
    );

    expect(await plan.approverDms).toEqual([]);
  });

  it("keeps the shared forwarder off a WhatsApp route the native client serves", () => {
    const suppress = (cfg: never) =>
      whatsappApprovalCapability.delivery?.shouldSuppressForwardingFallback?.({
        cfg,
        approvalKind: "plugin",
        target: { channel: "whatsapp", to: CONTACT, source: "session" },
        request: pluginRequest(),
      } as never);

    expect(suppress(buildConfig({ execApprovals: { approvers: [OWNER] } }))).toBe(true);
    expect(suppress(buildConfig({}))).toBe(false);
  });
});

describe("whatsapp approval authorization", () => {
  it.each([
    { name: "owner_is_authorized", senderId: OWNER, authorized: true },
    { name: "owner_jid_is_authorized", senderId: "15550000200@s.whatsapp.net", authorized: true },
    { name: "business_number_is_refused", senderId: BUSINESS, authorized: false },
    { name: "contact_is_refused", senderId: CONTACT, authorized: false },
  ])("$name", ({ senderId, authorized }) => {
    for (const cfg of [
      buildConfig({ execApprovals: { approvers: [OWNER] } }),
      buildConfig({}, { commands: { ownerAllowFrom: [`whatsapp:${OWNER}`] } }),
    ]) {
      for (const approvalKind of ["exec", "plugin", "system-agent"] as const) {
        expect(
          whatsappApprovalCapability.authorizeActorAction?.({
            cfg,
            accountId: "default",
            senderId,
            action: "approve",
            approvalKind,
          }).authorized,
        ).toBe(authorized);
      }
    }
  });

  it("refuses everyone when no approver resolves, allowFrom wildcard included", () => {
    expect(
      whatsappApprovalCapability.authorizeActorAction?.({
        cfg: buildConfig({}),
        accountId: "default",
        senderId: CONTACT,
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on WhatsApp.",
    });
  });

  it("lets an approvals.exec target recipient approve exec requests only", () => {
    const cfg = buildConfig(
      { execApprovals: { approvers: [OWNER] } },
      {
        approvals: {
          exec: { enabled: true, mode: "targets", targets: [{ channel: "whatsapp", to: CONTACT }] },
        },
      },
    );
    const authorize = (approvalKind: "exec" | "plugin") =>
      whatsappApprovalCapability.authorizeActorAction?.({
        cfg,
        accountId: "default",
        senderId: CONTACT,
        action: "approve",
        approvalKind,
      }).authorized;

    expect(authorize("exec")).toBe(true);
    expect(authorize("plugin")).toBe(false);
  });

  it("answers /approve exec when native approvals are off", () => {
    expect(
      whatsappApprovalCapability.resolveApproveCommandBehavior?.({
        cfg: buildConfig({}),
        accountId: "default",
        senderId: CONTACT,
        approvalKind: "exec",
      } as never),
    ).toEqual({
      kind: "reply",
      text: "❌ WhatsApp exec approvals are not enabled for this account.",
    });
  });
});

describe("whatsapp approval prompts", () => {
  it("renders exec prompts with thumbs-only reaction choices", () => {
    const payload = whatsappApprovalCapability.render?.exec?.buildPendingPayload?.({
      cfg: buildConfig({}),
      request: execRequest(),
      target: { channel: "whatsapp", to: OWNER, source: "target" },
      nowMs: 0,
    });
    const text = payload?.text ?? "";

    expect(text).toContain("/approve exec-1 allow-once");
    expect(text).toContain("👍 Allow Once");
    expect(text).toContain("👎 Deny");
    expect(text.indexOf("React with:")).toBeLessThan(text.indexOf("/approve exec-1 allow-once"));
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: ["allow-once", "deny"].map((decision) => ({
            action: { type: "approval", approvalId: "exec-1", approvalKind: "exec", decision },
          })),
        },
      ],
    });
  });

  it("renders plugin prompts with the plugin: id and its allowed decisions", () => {
    const payload = whatsappApprovalCapability.render?.plugin?.buildPendingPayload?.({
      cfg: buildConfig({}),
      request: pluginRequest(),
      target: { channel: "whatsapp", to: OWNER, source: "target" },
      nowMs: 0,
    });

    expect(payload?.text).toContain("Reply with: /approve plugin:approval-1 allow-once|deny");
    expect(payload?.text).toContain("👍 Allow Once");
    expect(payload?.text).toContain("👎 Deny");
    expect(payload?.presentation).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: ["allow-once", "deny"].map((decision) => ({
            action: {
              type: "approval",
              approvalId: "plugin:approval-1",
              approvalKind: "plugin",
              decision,
            },
          })),
        },
      ],
    });
  });
});
