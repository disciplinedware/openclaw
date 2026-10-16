import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and direct-message routing safety.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    dmPolicy: { channelKey: "whatsapp" },
  }),
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  execApprovals: {
    label: "WhatsApp Exec Approvals",
    help: "WhatsApp-native exec and plugin approval routing and approver authorization. When unset, OpenClaw auto-enables DM-first native approvals if approvers can be resolved for the selected account.",
  },
  "execApprovals.enabled": {
    label: "WhatsApp Exec Approvals Enabled",
    help: 'Controls WhatsApp native approvals for this account: unset or "auto" enables DM-first native approvals when approvers can be resolved, true forces native approvals on, and false disables them.',
  },
  "execApprovals.approvers": {
    label: "WhatsApp Exec Approval Approvers",
    help: "E.164 phone numbers allowed to approve requests for this WhatsApp account, by reaction or /approve. If you leave this unset, OpenClaw falls back to WhatsApp owner numbers from commands.ownerAllowFrom. allowFrom only admits senders; it never makes an approver.",
  },
  "execApprovals.approvers.*": { presentation: "phone-number" },
  "accounts.*.execApprovals.approvers.*": { presentation: "phone-number" },
  "execApprovals.notifyOrigin": {
    label: "WhatsApp Exec Approval Origin Notice",
    help: 'With target "dm", tell the chat a request came from that its approval went to approver DMs (default true). Set false when that chat is a customer\'s, so the customer sees no approval notice.',
  },
  "execApprovals.agentFilter": {
    label: "WhatsApp Exec Approval Agent Filter",
    help: 'Optional allowlist of agent IDs eligible for WhatsApp approvals, for example `["main", "ops-agent"]`. Use this to keep approval prompts scoped to the agents you actually operate from WhatsApp.',
  },
  "execApprovals.sessionFilter": {
    label: "WhatsApp Exec Approval Session Filter",
    help: "Optional session-key filters matched as substring or regex-style patterns before WhatsApp approval routing is used. Use narrow patterns so WhatsApp approvals only appear for intended sessions.",
  },
  "execApprovals.target": {
    label: "WhatsApp Exec Approval Target",
    help: 'Controls where WhatsApp approval prompts are sent: "dm" sends to approver DMs (default), "channel" sends to the originating WhatsApp chat, and "both" sends to both. Channel delivery shows the request to everyone in that chat, so only use it in trusted chats.',
  },
  ownMessages: {
    label: "WhatsApp Own Messages",
    help: 'Messages the linked phone sends itself to another person. "off" drops them (default); "history" keeps them as history for that chat; "turn" also runs the agent once, as a room event, in the direct session of the first WhatsApp owner in commands.ownerAllowFrom. Nothing is sent to the other person.',
  },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  direct: {
    label: "WhatsApp Direct Chat Overrides",
    help: 'Per-conversation overrides keyed by WhatsApp DM id. Applied after a DM is already admitted by dmPolicy; "*" supplies a default without admitting anyone.',
  },
  pluginHooks: {
    label: "WhatsApp Plugin Hooks",
    help: "Opt in to broadcasting inbound WhatsApp events to plugins. Payloads carry personal content, so only enable it for plugins you trust.",
  },
  ...createChannelConfigUiHints({ channelLabel: "WhatsApp", configWrites: true }),
  "actions.calls": {
    label: "WhatsApp Voice Calls",
    help: "Expose the experimental requester-bound WhatsApp voice-call tool. Default: false. Requires a separately paired MeowCaller CLI.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "WhatsApp",
    mentionPatterns: {
      targetDescription: "WhatsApp conversation IDs",
      policyTargetDescription: "WhatsApp conversation IDs such as 123@g.us",
    },
  }),
} satisfies Record<string, ChannelConfigUiHint>;
