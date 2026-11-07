# WhatsApp for Business

WhatsApp channel plugin with owner approvals and shared conversation history.
It is OpenClaw's WhatsApp plugin at `v2026.10.9` with one commit on top; `git diff v2026.10.9` shows every change.
It takes over channel `whatsapp` through `preferOver` and runs on a stock OpenClaw `2026.10.9`.
Its settings sit in `plugins.entries.whatsapp-for-business.config`.

## Install

The package is not published to npm or ClawHub. Build it from this branch and install the tarball:

```bash
pnpm install
OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR=/tmp/whatsapp-for-business bash scripts/plugin-npm-publish.sh --pack extensions/whatsapp
openclaw plugins install npm-pack:/tmp/whatsapp-for-business/disciplinedware-whatsapp-for-business-2026.10.9-1.tgz
```

Link a WhatsApp account through the plugin's setup flow, then configure which chats OpenClaw agents should monitor and reply to.

## Approvals

- The `message` tool's `send` takes the optional `requestApproval` boolean. An approval policy reads it; the plugin does not act on it.
- Approvers are `execApprovals.approvers`, else the WhatsApp owners in `commands.ownerAllowFrom`. `allowFrom` admits the people the agent talks to and never makes an approver. This differs from the stock plugin.
- Approval cards go to the approvers' direct chats. A reaction on any part of a split card answers it.
- `execApprovals.notifyOrigin: false` keeps the requesting chat free of the "sent to approvers" notice.
- `approvalLanguage` (`en` or `es`) sets the card's language. A call the card cannot read gets a card that only refuses.
- When a card ends (approved, rejected, expired, or answered by the business), the plugin edits the card itself: its last line with the reactions becomes the outcome. A failed edit sends the outcome as a reply to the card.
- A `message` action other than `send` (a reaction, an edit) is named on the card with its arguments.

## Recipients

- The `message` target `owner` writes to the one WhatsApp owner in `commands.ownerAllowFrom`; the agent does not see the number.
- A Mexican mobile written `+52…` or `+521…` is one person in `allowFrom`, owners, inbound senders and targets.
- A send goes to the chat WhatsApp registered for the number. A failed lookup fails the send.

## Approval context

Set `plugins.entries.whatsapp-for-business.config.approvalUnansweredMessageLimit` to an integer from 1 to 10. The default is 10.
The card shows, in this order: the recipient in bold and the approval's question (`description`), the recipient's latest unanswered messages as a WhatsApp quote (every line starts with `> `; blank lines dropped; each message cut to 300 characters), the proposed reply under "Reply:", then the reactions.
A delivered reply from the business phone or an agent ends the unanswered sequence.
A reply to another recipient and a failed send do not end that sequence.
The card counts earlier unanswered messages when the configured limit hides them.

## Conversation history

Messages typed on the linked business phone enter the recipient's OpenClaw transcript without starting an agent turn.
Old guest messages delivered after reconnect enter history after the normal access check. They do not trigger automatic replies.
Text, captions, locations and attachment markers remain visible. Attachment markers do not contain the attachment's contents.
The first message can come from either person. Message identities prevent repeated observations from creating repeated entries.
Old replies use their sent time, so delayed history does not hide newer questions.

Agent sends use OpenClaw's normal delivery history.
When another agent sends the reply, the plugin's `send` action records it in the recipient's session after WhatsApp accepts it.
It does not use OpenClaw's `message_sent` hook, which did not reach the plugin for a send from another agent's session.
The write follows delivery: a process failure between them loses the entry, and a failed write is logged as `whatsapp/history` while the send stays delivered.
A media-only send records an attachment marker without the file name.
The entry holds the text the agent sent; a `message_sending` hook that rewrites the text at delivery is not reflected, because the send result carries no delivered text.

The transcript is the only history store. The plugin uses the exported `session-transcript-runtime` writer from the pinned OpenClaw version.
OpenClaw classifies this SDK path as private-local. Test the packaged plugin before changing the OpenClaw version.
The plugin cannot restore messages that WhatsApp never delivers to the linked device.
Every approval card enters the approver's own transcript when it is sent, as a `whatsapp.approval-card` entry, and its outcome enters it when the card ends. The approver's agent then reads the approver's next message as an answer to that card. The entry holds the card text as WhatsApp shows it and a line `Conversation: <session key>` with the recipient's session, which the phone does not show; the agent opens it with `sessions_history`. The entry starts no agent turn and closes no card. A failed write is logged as `whatsapp/approvals`, and the card stays delivered.
A business reply to a guest (typed on the business phone, or sent by another agent) refuses that guest's open message cards: they are stale. A card from the owner's own chat for the same guest does so as soon as it appears, so one proposal stays open; a card from any other chat refuses none. The owner is recorded as the one who refused, and the card shows "Already answered" or "Updated below".

## Message delivery

The channel handles `message` sends through OpenClaw's durable delivery SDK.
Delivery hooks keep the requesting agent's session when the recipient belongs to another conversation.
The recipient remains the delivery target. The conversation history hook records successful cross-agent replies in the recipient's transcript.
Native target authorization, policy hooks, cancellation checks and delivery receipts still apply.
