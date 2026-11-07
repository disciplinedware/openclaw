# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions follow the upstream OpenClaw version they build on, with OpenClaw's correction suffix `-N`.

## [Unreleased]

### Fixed

- An approval card and its outcome enter the approver's own transcript. Before, the card reached the approver's WhatsApp but no transcript, so the approver's agent got the reply to a card it never saw and asked whom it was about.
- Host-requested sends retain the originating session in delivery hooks. Cross-conversation sends use the native channel action and durable delivery SDK.
- A message card shows its outcome in place: the plugin edits the card, and its reaction line becomes "Approved", "Rejected", "Expired without an answer" or "Already answered". A reaction on a closed card does nothing, and the card now says so.
- A business reply to a guest (typed on the business phone, or sent by another agent) refuses that guest's open message cards, so an outdated proposal cannot reach the guest after the host answered. A card from the owner's own chat (the owner's agent writing to that guest) refuses them when it appears, and they show "Updated below"; a card from any other chat refuses none.
- A message card reads in the order of a chat: the recipient in bold with the approval's question, the guest's unanswered messages as a WhatsApp quote, the proposed text under "Reply:", then the reactions. The recipient is named once, not above the history and again under "To".
- An approval of a `message` action other than `send` (`react`, `edit`, `delete`) names that action on the card instead of "Reply:", so the approver sees what runs.
- A send from another agent's session enters the recipient's transcript from the plugin's `send` action, after WhatsApp accepts it. The `message_sent` hook that wrote it before never reached the plugin in a live run, so the guest's agent and the approval card took answered questions for unanswered ones.

### Added

- Business-phone messages and old guest appends enter the guest transcript without starting an agent turn. Cross-agent deliveries also appear in that transcript.
- Approval cards use the recipient's unanswered messages, ordered by sent time. `approvalUnansweredMessageLimit` accepts 1–10 and defaults to 10.
- The stock OpenClaw WhatsApp channel plugin at `v2026.10.9`, packaged as plugin `whatsapp-for-business`: it takes over channel `whatsapp` through `preferOver` and ships its own copy of the channel config schema, so it runs on a stock OpenClaw. Its settings sit in `plugins.entries.whatsapp-for-business.config`.
- The `message` tool's `send` takes the optional `requestApproval` boolean: the agent asks a human to review the message. An approval policy reads it; the plugin does not act on it.
- Approvers apart from `allowFrom`: `execApprovals` (`enabled`, `approvers`, `agentFilter`, `sessionFilter`, `target`), as `channels.telegram.execApprovals`, plus `notifyOrigin` (default `true`). Approvers are `execApprovals.approvers`, else the WhatsApp owners in `commands.ownerAllowFrom`; `allowFrom`, which admits the people the agent talks to, never makes an approver. Cards go to the approvers' DMs.
- The message card: a plugin approval of the `message` tool shows the conversation's unanswered messages (`approvalUnansweredMessageLimit`, default 10), then the recipient, the text and every other argument of the call. Both come from the session transcript, where OpenClaw stores the call before it asks for approval; the call is found by the request's `toolCallId`. `approvalLanguage` (`en` or `es`) sets the card's language.
- The `message` target `owner`: the agent writes to the one WhatsApp owner in `commands.ownerAllowFrom` without knowing the number.
- A send to a phone number goes to the chat WhatsApp registered for it (Baileys `onWhatsApp`, remembered per connection): a Mexican mobile written `+52…` is registered as `521…`, and a send to the written digits is accepted and never delivered. A failed lookup fails the send.
