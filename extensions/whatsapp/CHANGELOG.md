# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions follow the upstream OpenClaw version they build on, with OpenClaw's correction suffix `-N`.

## [Unreleased]

### Added

- The OpenClaw WhatsApp channel plugin at `v2026.10.2`, built from the disciplinedware OpenClaw fork as plugin `whatsapp-for-business`; it takes over channel `whatsapp` through `preferOver` and ships its own copy of the channel config schema.
- `ownMessages` (`off`, `history`, `turn`): a message that the linked phone itself sends to a direct chat becomes history of that chat and, in `turn` mode, one agent run, a room event, in the session of the first WhatsApp owner in `commands.ownerAllowFrom`. Echoes, backfill, groups, the account's own chat, reactions, edits and deletes are excluded. The message reads as OpenClaw writes a message the account sent: `[WhatsApp <other person> <time>] (self): <text>`, in the owner turn and in the chat's history.
- `execApprovals` (`enabled`, `approvers`, `agentFilter`, `sessionFilter`, `target`), as `channels.telegram.execApprovals`, plus `notifyOrigin` (default `true`; `false` keeps the originating chat, a guest's, free of the routed-to-DMs notice): approvers are E.164 numbers, else the WhatsApp owners in `commands.ownerAllowFrom`; prompts go to the approvers' DMs by default with the 👍/👎 reaction bound; only approvers resolve exec, plugin and system-agent approvals.

- `message` target `owner`: the agent writes to the one WhatsApp owner in `commands.ownerAllowFrom` without seeing the number. Core, hooks and the tool result see `owner`; only the transport send resolves it, and its results and errors name the chat `owner`. Zero or several WhatsApp owners fail without naming a number.
- Cross-chat send history: a `message` send from the owner's direct session to another person's direct chat becomes history of that chat, read by its next turn as `(self): [sent by the assistant from another chat] <text>`, because OpenClaw's delivery mirror never reaches the model. A send from anyone else's chat is not recorded, because it can carry that person's words, which the recipient's turn would read as the assistant's own. The assistant's entries reach a chat's turn whatever `ownMessages` is; with `ownMessages: "off"`, phone-typed entries stored before the switch are consumed without being shown. A send that names no `accountId` is filed under the one account on which the sending session is the owner's chat; when no single account matches, nothing is recorded.

### Changed

- Breaking against upstream: `allowFrom` no longer makes an approver, because with `allowFrom: ["*"]` every guest could approve. Name approvers in `execApprovals.approvers` or `commands.ownerAllowFrom`.
