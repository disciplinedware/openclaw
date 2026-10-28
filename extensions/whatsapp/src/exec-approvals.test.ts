import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";
import {
  clearWhatsAppApprovalReactionTargetsForTest,
  maybeResolveWhatsAppApprovalReaction,
  registerWhatsAppApprovalReactionTarget,
} from "./approval-reactions.js";
import {
  getWhatsAppExecApprovalApprovers,
  isWhatsAppExecApprovalClientEnabled,
  resolveWhatsAppExecApprovalTarget,
} from "./exec-approvals.js";
import { acceptsWhatsAppPluginConfig, whatsappPluginEntries } from "./plugin-config.test-helper.js";

const resolverMocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>()),

  resolveApprovalOverGateway: resolverMocks.resolveApprovalOverGateway,
}));

const BUSINESS = "+15550000100";
const OWNER = "+15550000200";
const CONTACT = "+15550000300";
const PROMPT_CHAT_JID = "15550000200@s.whatsapp.net";
const PROMPT_MESSAGE_ID = "approval-prompt";

/** A public business: anyone may write to it, so allowFrom is a wildcard. */
function publicBusinessConfig(params: { approvers?: string[]; ownerAllowFrom?: string[] } = {}) {
  return {
    ...(params.ownerAllowFrom ? { commands: { ownerAllowFrom: params.ownerAllowFrom } } : {}),
    channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"] } },
    ...(params.approvers
      ? { plugins: whatsappPluginEntries({ execApprovals: { approvers: params.approvers } }) }
      : {}),
  } as never;
}

describe("execApprovals config", () => {
  it.each([
    { name: "accepts_e164_approvers", value: { approvers: [OWNER] }, ok: true },
    {
      name: "accepts_every_standard_key",
      value: {
        enabled: "auto",
        approvers: [OWNER],
        agentFilter: ["main"],
        sessionFilter: ["whatsapp"],
        target: "both",
      },
      ok: true,
    },
    { name: "accepts_enabled_false", value: { enabled: false }, ok: true },
    { name: "accepts_notify_origin_false", value: { notifyOrigin: false }, ok: true },
    { name: "refuses_non_boolean_notify_origin", value: { notifyOrigin: "no" }, ok: false },
    { name: "refuses_wildcard", value: { approvers: ["*"] }, ok: false },
    { name: "refuses_non_e164", value: { approvers: ["15550000200"] }, ok: false },
    { name: "refuses_group_jid", value: { approvers: ["120363401234567890@g.us"] }, ok: false },
    { name: "refuses_unknown_target", value: { target: "group" }, ok: false },
    { name: "refuses_unknown_key", value: { approver: [OWNER] }, ok: false },
  ])("$name", ({ value, ok }) => {
    expect(acceptsWhatsAppPluginConfig({ execApprovals: value })).toBe(ok);
  });

  it("is a plugin setting, which the core-owned channels.whatsapp refuses", () => {
    expect(WhatsAppConfigSchema.safeParse({ execApprovals: { approvers: [OWNER] } }).success).toBe(
      false,
    );
  });
});

describe("execApprovals approvers", () => {
  it.each([
    { name: "explicit_approvers", params: { approvers: [OWNER] }, expected: [OWNER] },
    {
      name: "owner_allow_from_whatsapp_entries",
      params: { ownerAllowFrom: [`whatsapp:${OWNER}`, "telegram:123456789", "*"] },
      expected: [OWNER],
    },
    {
      name: "explicit_approvers_win_over_owner_allow_from",
      params: { approvers: [OWNER], ownerAllowFrom: [`whatsapp:${BUSINESS}`] },
      expected: [OWNER],
    },
    { name: "never_allow_from", params: {}, expected: [] },
  ])("$name", ({ params, expected }) => {
    expect(
      getWhatsAppExecApprovalApprovers({ cfg: publicBusinessConfig(params), accountId: "default" }),
    ).toEqual(expected);
  });

  it("enables the client on auto once an approver resolves, and targets approver DMs", () => {
    const cfg = publicBusinessConfig({ ownerAllowFrom: [`whatsapp:${OWNER}`] });
    expect(isWhatsAppExecApprovalClientEnabled({ cfg, accountId: "default" })).toBe(true);
    expect(resolveWhatsAppExecApprovalTarget({ cfg, accountId: "default" })).toBe("dm");
    expect(
      isWhatsAppExecApprovalClientEnabled({ cfg: publicBusinessConfig(), accountId: "default" }),
    ).toBe(false);
  });
});

function reactionFrom(params: { actorJid: string; fromMe?: boolean }) {
  return {
    key: {
      id: `reaction-${params.actorJid}`,
      remoteJid: params.fromMe ? PROMPT_CHAT_JID : params.actorJid,
      fromMe: params.fromMe ?? false,
    },
    message: {
      reactionMessage: {
        text: "👍",
        key: { remoteJid: PROMPT_CHAT_JID, id: PROMPT_MESSAGE_ID, fromMe: true },
      },
    },
  } as never;
}

const E164_BY_JID: Record<string, string> = {
  "15550000100@s.whatsapp.net": BUSINESS,
  "15550000200@s.whatsapp.net": OWNER,
  "15550000300@s.whatsapp.net": CONTACT,
};

async function react(params: {
  config: Parameters<typeof publicBusinessConfig>[0];
  actorJid: string;
  fromMe?: boolean;
}) {
  const logVerboseMessage = vi.fn();
  const handled = await maybeResolveWhatsAppApprovalReaction({
    cfg: publicBusinessConfig(params.config),
    accountId: "default",
    msg: reactionFrom(params),
    selfJid: "15550000100@s.whatsapp.net",
    resolveInboundJid: async (jid) => (jid ? (E164_BY_JID[jid] ?? null) : null),
    logVerboseMessage,
  });
  return { handled, logVerboseMessage };
}

describe("approval reactions on a prompt in the owner's DM", () => {
  beforeEach(async () => {
    clearWhatsAppApprovalReactionTargetsForTest();
    resolverMocks.resolveApprovalOverGateway.mockReset();
    resolverMocks.resolveApprovalOverGateway.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    // The binding the native runtime registers after it delivers the prompt.
    await registerWhatsAppApprovalReactionTarget({
      accountId: "default",
      remoteJid: PROMPT_CHAT_JID,
      messageId: PROMPT_MESSAGE_ID,
      approvalId: "plugin:approval-1",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it.each([
    { name: "execApprovals_approvers", config: { approvers: [OWNER] } },
    { name: "commands_ownerAllowFrom", config: { ownerAllowFrom: [`whatsapp:${OWNER}`] } },
  ])("resolves the approval for the owner from $name", async ({ config }) => {
    const { handled } = await react({ config, actorJid: "15550000200@s.whatsapp.net" });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledOnce();
    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "plugin:approval-1",
        approvalKind: "plugin",
        decision: "allow-once",
        senderId: OWNER,
      }),
    );
  });

  it.each([
    { name: "business_number", actorJid: PROMPT_CHAT_JID, fromMe: true, sender: BUSINESS },
    { name: "contact", actorJid: "15550000300@s.whatsapp.net", fromMe: false, sender: CONTACT },
  ])("resolves nothing for a reaction from the $name", async ({ actorJid, fromMe, sender }) => {
    const { handled, logVerboseMessage } = await react({
      config: { approvers: [OWNER] },
      actorJid,
      fromMe,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      `whatsapp: approval reaction denied id=plugin:approval-1 sender=${sender}`,
    );
  });

  it("resolves nothing for a contact when no approver resolves and allowFrom is a wildcard", async () => {
    const { handled } = await react({ config: {}, actorJid: "15550000300@s.whatsapp.net" });

    expect(handled).toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
