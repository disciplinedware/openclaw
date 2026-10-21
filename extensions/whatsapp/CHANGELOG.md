# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions follow the upstream OpenClaw version they build on, with OpenClaw's correction suffix `-N`.

## [Unreleased]

### Added

- Message cards show the recipient's unanswered messages above the proposal (`approvalUnansweredMessageLimit`, default 10), with the sender and local times. A card cancelled before a decision reads `🔄 Cancelled before a decision.` and becomes `🔄 Updated below.` when a newer card for the same recipient follows; the session's next turn receives its cancelled proposals (`cancelled_proposals`); an expired card gets one reminder of who waits; a reaction on a closed card gets the answer that nothing was sent.

### Changed

- A session's turn receives the proposals that the message starting it cancelled. The plugin read them when the message arrived, before the message cancelled the running turn, so the turn after a cancelled card saw nothing and the guest never got the cancelled answer.

- A rejection reads `❌ Rejected.` instead of `❌ Not run.`, and an expiry `⏱️ Expired without an answer.` without the request for a new proposal, which made the agent propose again every five minutes.

### Fixed

- While a person has several messages that no delivered message answered, each turn receives them, with their text, as channel structured context (`unanswered_messages`). Under queue mode `interrupt` a new message cancelled the proposal for the earlier ones, and the agent took the cancelled proposal for a delivered answer and answered only the newest message.
- A turn that sends nothing no longer marks its messages answered while a newer message of the person waits. Under queue mode `interrupt` the new message cancelled the turn before it chose anything, the cancelled turn counted as silence, and its messages left the `unanswered_messages` list: the agent answered only the last two questions.
- History entries (phone-typed messages, the owner agent's sends, approval prompts and outcomes) are custom messages (`whatsapp.history`), not assistant messages. As assistant messages, transcript repair could place one between a tool result and a system update, which Anthropic refuses with a 400.

### Changed

- A Spanish approval card ends in one line: `👍 Enviar · 👎 Rechazar · 5 min`.

### Added

- `execApprovals` and `ownMessages` move to `plugins.entries.whatsapp-for-business.config`, validated by the plugin's own `configSchema`, so `channels.whatsapp` keeps OpenClaw's schema and the plugin runs on a stock OpenClaw without core changes. A setting now applies to every WhatsApp account.
- `plugins.entries.whatsapp-for-business.config.historyAuthors` (`phone`, `ownerAgent`, `approval`): every history entry the plugin writes carries OpenClaw's frame with the other person and the time, and names its author in the deployment's words instead of `(self)` and a bracketed note, which agents read as their own words.

- Completed native approvals remove their WhatsApp prompts and receive short outcome notices. Failed deletion keeps terminal presentation.

- The OpenClaw WhatsApp channel plugin at `v2026.10.2`, built from the disciplinedware OpenClaw fork as plugin `whatsapp-for-business`; it takes over channel `whatsapp` through `preferOver` and ships its own copy of the channel config schema.
- `ownMessages` (`off`, `history`, `turn`): a message that the linked phone itself sends to a direct chat becomes history of that chat and, in `turn` mode, one agent run, a room event, in the session of the first WhatsApp owner in `commands.ownerAllowFrom`. Echoes, backfill, groups, the account's own chat, reactions, edits and deletes are excluded. The owner turn reads it as OpenClaw writes a message the account sent: `[WhatsApp <other person> <time>] (self): <text>`; the chat's history names its author (`historyAuthors.phone`).
- `execApprovals` (`enabled`, `approvers`, `agentFilter`, `sessionFilter`, `target`), as `channels.telegram.execApprovals`, plus `notifyOrigin` (default `true`; `false` keeps the originating chat, a contact's, free of the routed-to-DMs notice): approvers are E.164 numbers, else the WhatsApp owners in `commands.ownerAllowFrom`; prompts go to the approvers' DMs by default with the 👍/👎 reaction bound; only approvers resolve exec, plugin and system-agent approvals.

- `message` target `owner`: the agent writes to the one WhatsApp owner in `commands.ownerAllowFrom` without seeing the number. Core, hooks and the tool result see `owner`; only the transport send resolves it, and its results and errors name the chat `owner`. Zero or several WhatsApp owners fail without naming a number.
- Cross-chat send history: a `message` send from the owner's direct session to another person's direct chat becomes history of that chat, read by its next turn as `[WhatsApp <other person> <time>] Owner's AI agent: <text>` (`historyAuthors.ownerAgent`), because OpenClaw's delivery mirror never reaches the model. A send from anyone else's chat is not recorded, because it can carry that person's words, which the recipient's turn would read as the owner's side. The assistant's entries reach a chat's turn whatever `ownMessages` is; with `ownMessages: "off"`, phone-typed entries stored before the switch are consumed without being shown. A send that names no `accountId` is filed under the one account on which the sending session is the owner's chat; when no single account matches, nothing is recorded.
- Overdue answers: a person whose earliest message that nothing from the business number answered waited more than 15 minutes, whatever the reason, gets nothing automatic; only the owner may be written to. The plugin keeps that message per person and account in plugin state, from every arrival path (live, backfill, reconnect, durable replay); only a message delivered to the person ends it (the plugin's send, or the phone's own message). A `message` or `whatsapp_call` call reaching such a person is refused at the call, except from the owner's own run (never under `dmScope: "main"`); a turn starting then reads why and sends no reply, typing or reaction, and the person's messages get no read receipt. Missed direct backfill gets a turn; group backfill stays skipped and unread. Automatic replies that core delivers outside the plugin's reply path (follow-up `routeReply`) are a known limit.
- `plugins.entries.whatsapp-for-business.config.blockOverdueAnswers` (default `true`): `false` disables overdue send refusal and owner-only turn warnings, but keeps unanswered-message state and catch-up tracking. Configure another policy when every outbound message needs approval. When disabled, each turn states the current mode and that an old refusal does not establish current permission; other policies and approval requirements still apply.
- `plugins.entries.whatsapp-for-business.config.approvalLanguage` (`en` by default, or `es`): selects the language of native Guardian approval instructions and outcomes. In Spanish, the native message-send title `Approve message?` appears as `¿Enviar mensaje?`; the adapter description and other plugin approval titles stay unchanged.
- The shared `message` tool exposes the optional `requestApproval` boolean for WhatsApp sends, including cross-chat discovery. The WhatsApp payload preparation blocks a flagged send if no approval policy clears the flag; `plugins.entries.whatsapp-for-business.config.unhandledApprovalPolicy` defaults to `block` and can be set to `send` to allow flagged sends through when no policy handles them. The plugin does not create or record approvals, and it returns the prepared payload unchanged.
- The shared `message` tool exposes optional string `replyContext` for sends and reactions. Its description explains conditional approval validation and correction. Summary metadata stays outside the delivered text and media.

### Fixed

- A send to a phone number goes to the chat WhatsApp registered for it, found with Baileys `onWhatsApp` and kept for one hour, never to a JID built from the E.164 digits: a Mexican mobile `+52…` registered as `521…` got a message WhatsApp accepted and never delivered. A number without a WhatsApp account is refused and nothing is sent; a failed lookup fails the send as retryable.
- Overdue answers, the send guard and cross-chat send history key a person by the number WhatsApp registered, so a send to `+52…` answers messages from `+521…` and the guard refuses it while that person's answer is overdue.
- A send to target `owner` returns no number when WhatsApp registered the owner's chat under other digits than `commands.ownerAllowFrom` names.

### Changed

- Breaking against upstream: `allowFrom` no longer makes an approver, because with `allowFrom: ["*"]` every contact could approve. Name approvers in `execApprovals.approvers` or `commands.ownerAllowFrom`.
