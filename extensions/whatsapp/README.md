# whatsapp-for-business

The OpenClaw WhatsApp channel plugin (`@openclaw/whatsapp`, OpenClaw `v2026.10.2`), built from the disciplinedware fork of OpenClaw (github.com/disciplinedware/openclaw). Branch `whatsapp-own-messages-approvals` holds own messages and native approvals in the shape upstream would take them; branch `whatsapp-for-business` adds one packaging commit that publishes them as this package, and then the `owner` target and cross-chat send history. It keeps the channel id `whatsapp`, so routing, session keys, `toolsBySender` keys (`e164:<phone>`) and other plugins see no difference. It changes these things:

| Capability          | Config key                                                                    | Upstream behavior                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Own messages        | `plugins.entries.whatsapp-for-business.config.ownMessages`                    | A message that the linked phone itself sends to another person is dropped. The agent never sees it.                                                                                                                                                                                                                                                                                                                                        |
| Native approvals    | `plugins.entries.whatsapp-for-business.config.execApprovals`                  | WhatsApp has no `execApprovals` block. Approvers come from `allowFrom`, so with `allowFrom: ["*"]` anyone who can react to the prompt resolves it, the business number included. Native prompts need `approvals.exec` or `approvals.plugin` and go to the chat that the request came from.                                                                                                                                                 |
| `owner` target      | `commands.ownerAllowFrom`                                                     | To write to the owner, the agent must know the owner's number, and the number comes back in the `message` tool result.                                                                                                                                                                                                                                                                                                                     |
| History authors     | `plugins.entries.whatsapp-for-business.config.historyAuthors`                 | OpenClaw writes the account's own messages as `(self)`. `phone`, `ownerAgent` and `approval` name the author of a history entry in the deployment's words.                                                                                                                                                                                                                                                                                 |
| Send history        | none                                                                          | A `message` send from one chat's session to another chat reaches that chat's transcript as a delivery mirror, which the model never reads: the recipient's next turn does not know what was written to them.                                                                                                                                                                                                                               |
| Overdue answers     | `plugins.entries.whatsapp-for-business.config.blockOverdueAnswers`            | When enabled, the plugin refuses overdue sends. When disabled, each turn receives the current policy, and an old refusal does not establish current permission. Other policies and approval requirements still apply.                                                                                                                                                                                                                      |
| Unanswered messages | none                                                                          | A new message under queue mode `interrupt` cancels the running turn and its pending proposal. The next turn sees the cancelled proposal in the transcript and cannot tell that it was never delivered. While a person has several messages without a delivered answer, each turn receives them with their text and the rule to answer all of them.                                                                                         |
| Message cards       | `plugins.entries.whatsapp-for-business.config.approvalUnansweredMessageLimit` | A message approval shows only the requester's text, and a cancelled one reads as denied. A message card shows the recipient's unanswered messages above the proposal; a card cancelled before a decision reads as cancelled and, once a newer card for the same recipient follows, as updated below; the next turn of the session receives its cancelled proposals; an expired card is followed by one reminder while the recipient waits. |

Native approvals follow `channels.telegram.execApprovals`: the same keys, the same approver fallback to `commands.ownerAllowFrom`, the same DM-first delivery. This is a breaking change against upstream: `allowFrom` no longer makes anyone an approver, so a config that relied on it must name the approvers in `execApprovals.approvers` or `commands.ownerAllowFrom`. Without `ownMessages`, own messages behave as upstream. `NOTICE` names the upstream source; `git diff v2026.10.2 whatsapp-for-business -- extensions/whatsapp src/config` shows every change.

## Requirements

Approved plugin requests retain their proposed text. Rejected, cancelled and expired plugin requests show only the terminal status. A deny that the approver's reaction did not make is a cancellation: the run that asked stopped before a decision.
Approval, denial and expiry update the existing card. Failed editing sends a quoted terminal update.
The native handler unbinds reactions before terminal transport. Cleanup failure never restores approval authority.
For message approvals with native `scope.kind: "message-send"` and `scope.target: "whatsapp"`, a quoted receipt reports the settled send result.
The receipt matches the native run, session and tool-call identities. Authorization alone never establishes delivery.
The approval edit and receipt can arrive in either order. A successful receipt explicitly states both approval and sending.
Failed receipt delivery stays in the retained outbox for startup recovery. Recovery never retries the original operation.
An interrupted process without a settled result produces an unknown outcome, not a successful-send claim.
Receipt recovery is at least once: a crash after transport acceptance can repeat a status notice.
Cards and status notices enter the owner's native transcript with source and recipient conversation references. These references remain history-only.

- OpenClaw `2026.10.2` (`compat.pluginApi >=2026.10.2`).
- Node.js `>=24.16.0 <25 || >=26.1.0`, as OpenClaw requires.

## Install from a local path

Pack the plugin with OpenClaw's own plugin pack script, from the fork's root on branch `whatsapp-for-business`, then install the tarball:

```bash
pnpm install --frozen-lockfile
pnpm build                      # the pack needs the host SDK output in dist/plugin-sdk
OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR=/tmp/plugins bash scripts/plugin-npm-publish.sh --pack extensions/whatsapp
openclaw plugins install npm-pack:/tmp/plugins/disciplinedware-whatsapp-for-business-2026.10.2-1.tgz \
  --force --accept-capabilities
```

The pack needs Node.js 24 with npm 11 or newer installed next to the `node` binary: OpenClaw's npm runner prefers that npm, and npm 10 runs Baileys' `prepare` script and fails. The tarball bundles its runtime dependencies, including Baileys with the patch the monorepo applies (`patches/baileys@7.0.0-rc14.patch`). The version follows OpenClaw's release grammar: `2026.10.2-1` is a correction of `2026.10.2`.

Install the plugin before you add the keys below to the config: until the plugin is installed, OpenClaw refuses `plugins.entries.whatsapp-for-business`.

An installed plugin is not bundled, so OpenClaw blocks its conversation hooks until `plugins.entries.whatsapp-for-business.hooks.allowConversationAccess` is `true`. Message cards need them: `before_prompt_build` gives a turn its cancelled proposals and `agent_end` ends a run's record of declined proposals. Without the grant the gateway logs `typed hook "before_prompt_build" blocked`.

## Taking over the `whatsapp` channel

The plugin id is `whatsapp-for-business`; the channel id stays `whatsapp`. The manifest declares `channelConfigs.whatsapp.preferOver: ["whatsapp"]`. OpenClaw then validates `channels.whatsapp` with this plugin's schema and does not start the upstream plugin, as long as nobody selected the upstream plugin explicitly.

Explicit selection wins over `preferOver`. Make sure that exactly one owner is selected:

- `openclaw plugins install` writes `plugins.entries.<id>.enabled: true` for every plugin it installs. If the upstream plugin was installed this way, set `plugins.entries.whatsapp.enabled: false` or uninstall it.
- If the upstream plugin is loaded through `plugins.load.paths` and `plugins.allow`, replace `whatsapp` with `whatsapp-for-business` there.
- If both plugins are enabled explicitly, OpenClaw loads both. The first one registers the channel; the gateway log then shows `channel already registered: whatsapp (whatsapp) (plugin=whatsapp-for-business, ...)`.

The linked-device credentials stay where they are (`authDir`), so no new QR link is needed. Plugin-scoped state starts empty, because OpenClaw keys it by plugin id: the durable inbound queue and the approval reaction bindings of the upstream plugin are not carried over.

## Config reference

The plugin's settings sit in `plugins.entries.whatsapp-for-business.config`, which the plugin's own `configSchema` (openclaw.plugin.json) validates. `channels.whatsapp` keeps OpenClaw's own schema unchanged, so the plugin runs on a stock OpenClaw. A setting applies to every WhatsApp account. The plugin reads it for each message, so a config change applies without a restart.

### Overdue answers

`blockOverdueAnswers` defaults to `true`. When it is `false`, the plugin adds a current-turn fact that its overdue refusal is disabled. The fact does not grant permission under another policy or remove approval requirements.

### Message cards

A message approval card (`scope.kind: "message-send"`, `scope.target: "whatsapp"`) starts with each recipient's messages that no delivered message answered, as `overdue-answers.ts` keeps them: the sender's name and number, then one line per message with its time in `agents.defaults.userTimezone` (UTC when unset). It shows the newest `approvalUnansweredMessageLimit` messages (default 10) and a line counts the earlier ones. The proposal and the reaction line follow, so they stay at the bottom of the message.

| How the approval ended                                    | The card reads                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A reaction approved it                                    | `✅ Approved.` and the proposal                                                                                               |
| A reaction rejected it                                    | `❌ Rejected.`                                                                                                                |
| The run that asked stopped first (queue mode `interrupt`) | `🔄 Cancelled before a decision.`, then `🔄 Updated below.` once a newer card for one of its recipients reaches the same chat |
| Nobody answered in time                                   | `⏱️ Expired without an answer.`, and one reminder below it names who waits and since when, while their messages still wait    |

A cancelled proposal reaches the next turns of the session that proposed it as prompt context (`cancelled_proposals`, from the `before_prompt_build` hook), with the rule to propose again what the conversation still asks for, until a newer card to the same recipient or the overdue-answer threshold. A decision reaction on a closed card resolves nothing; the plugin replies that the card is no longer active. Several cards may wait for one recipient: only a cancellation leads to a replacement. The context is read when the turn's prompt is built, because the message that starts the turn is what cancels the previous turn's proposal; a card of the session still open at that moment belongs to a run that has ended, so the turn receives it as cancelled.

An expired or rejected card ends what its run may propose to those recipients: a later `message` call of the same run to one of them is refused with the reason to end the turn, because the approver already let the card pass or refused it. A new message starts a new run, which may propose again.

### `execApprovals`

```json5
{
  commands: { ownerAllowFrom: ["whatsapp:+15550000200"] }, // the owner, for every channel
  channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"] } }, // who may talk to the agent
  plugins: {
    entries: {
      "whatsapp-for-business": {
        config: { execApprovals: { approvers: ["+15550000200"] } }, // optional when ownerAllowFrom names the owner
      },
    },
  },
}
```

| Key             | Values                                    | Effect                                                                                                                                               |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`       | `"auto"` (default), `true`, `false`       | `"auto"` and `true` turn native approvals on when at least one approver resolves; `false` turns them off.                                            |
| `approvers`     | E.164 numbers                             | Who may approve. Unset or empty: the WhatsApp entries of `commands.ownerAllowFrom` (`whatsapp:+15550000200` or a bare number).                       |
| `target`        | `"dm"` (default), `"channel"`, `"both"`   | Where the prompt goes: the approvers' direct chats, the chat that the request came from, or both. `channel` shows the request to that chat.          |
| `agentFilter`   | agent ids                                 | Only requests of these agents.                                                                                                                       |
| `sessionFilter` | session-key patterns (substring or regex) | Only requests of matching sessions.                                                                                                                  |
| `notifyOrigin`  | `true` (default), `false`                 | With `target: "dm"`, whether the chat that the request came from hears that the request went to WhatsApp DMs. `false` keeps a contact's chat silent. |

Authorization:

- Only a resolved approver resolves an exec, plugin (`plugin:` id) or system-agent approval, by a 👍/👎 reaction on the prompt or by `/approve`. Everyone else is refused, the business number and every contact included.
- `allowFrom`, `dmPolicy` and `defaultTo` admit senders and set default targets; they never make an approver.
- No approver resolves: nobody approves in WhatsApp, and `/approve` for an exec request answers that WhatsApp exec approvals are not enabled. The Web UI still approves.
- A recipient of an `approvals.exec` target in mode `targets` or `both` may also approve exec requests, as on Telegram.

Delivery:

- The native runtime of the account handles exec, plugin and system-agent approvals that match the account and the filters, with no `approvals.exec` or `approvals.plugin` config. It sends the prompt, binds the 👍/👎 reaction to that message, and updates the prompt when the approval resolves or expires.
- For a request that came from WhatsApp, OpenClaw's shared forwarder sends no second WhatsApp copy.
- With `target: "dm"`, the chat that the request came from gets OpenClaw's notice `Approval required. I sent the approval request to WhatsApp DMs, not this chat.`, as on Telegram, Discord and Slack. For a request from a contact's chat, the contact sees that notice; `notifyOrigin: false` keeps that chat silent while the approvers still get the prompt.
- If every native delivery of a request fails, OpenClaw sends a delivery-failed notice with the approval id and the `/approve` commands to the chat that the request came from. Only an approver can use it.
- Native prompts go through the plugin's own WhatsApp send path, so the `message_sending` hook does not run for them.
- `approvals.exec` and `approvals.plugin` with WhatsApp targets still work through the shared forwarder, as upstream; the reaction binds to the delivered message and the rules above authorize it.

Hooks receive the original admitted message body in `ctx.channelContext.chat.receivedText` for the current run. An approval may quote this text separately from the proposed message. The text does not establish sender identity or permission.

The `message` tool exposes optional string `replyContext` for sends and reactions, including cross-chat discovery.
The model supplies the relevant request and unresolved questions in this field alongside the exact operation arguments.
The field is review metadata. It is not appended to outgoing text or media and does not authorize delivery.
The ACS adapter requires a nonempty summary when Guardian returns `ask`; ordinary calls on `allow` need no summary.
Missing or oversized summaries produce correction errors before approval. The adapter does not invoke another model or read history.

### `ownMessages`

```json5
{
  commands: { ownerAllowFrom: ["whatsapp:+15550000200"] }, // the owner, as for execApprovals
  plugins: { entries: { "whatsapp-for-business": { config: { ownMessages: "turn" } } } },
}
```

An own message is a message that the linked phone itself sends, live, to another person's direct chat: for example, the owner of the business types to a contact on the business phone.

| Value           | Effect                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Upstream behavior: the message is dropped.                                                                                                                                                                                                               |
| `history`       | The message is appended to that chat's native session transcript. No agent run starts and no message is sent.                                                                                                                                            |
| `turn`          | The same transcript entry, and one agent run in the owner's direct session on this account, as a room event (`InboundEventKind: "room_event"`): the agent observes what the owner said and replies only with the `message` tool, when a reply is useful. |

The owner is the first entry of `commands.ownerAllowFrom` that is `whatsapp:+<number>` or a bare number: the same owner list that `execApprovals` falls back to, picked the way OpenClaw picks the owner route for heartbeat delivery. In `turn` mode without such an entry, the history is kept, no turn runs, and the gateway log says so.

History:

- Each message is appended to the direct chat's native transcript as a custom message (`customType: "whatsapp.history"`), as core's `AgentSession.sendCustomMessage` records application context; the model reads it as context, never as its own words: `[WhatsApp <other person> <time>] <author>: <text>`, the frame OpenClaw writes for every incoming message: the chat, the time, then who wrote. The author is `historyAuthors.phone` (default `Typed on this number's phone`), then the message text and media placeholder. The core's `(self)` is not used: the reading agent takes it for its own words.
- A retained plugin-state outbox retries failed transcript appends at startup. It removes an entry only after the native transcript append succeeds.

The owner turn:

- Its message body is the own message as OpenClaw writes a message the account itself sent in a direct chat (`formatInboundEnvelope` with `fromMe`): the other person's number in the envelope, then `(self):` and the content (text, then a media placeholder such as `<media:image>`):

  ```text
  [WhatsApp +15550000300 Thu 2025-10-09T08:53:20Z] (self): The report is ready on Mondays.
  ```

  The timestamp follows the envelope settings of every inbound message (`agents.defaults.userTimezone`); the example shows UTC. The turn's prompt carries this line once: the owner chat adds no second envelope.

- Hooks read the same facts from `ctx.channelContext.chat.ownMessage`: `{ messageId, peerE164, timestampMs }`.
- Only `channelContext.chat.ownMessage` proves an owner turn: the plugin alone sets it. Any sender can type such a line into a message, so hooks and prompts must not treat the text as authority.
- The owner goes through normal DM admission (`dmPolicy`, `allowFrom`, pairing store). If the owner is not admitted, the history is still kept and no turn runs. No pairing challenge is sent.
- The turn has no inbound message in the owner chat, so it gets no ack reaction, no read receipt and no implicit quote. A reply of the agent goes to the owner chat, like a reply to a message that the owner wrote.
- Nothing is ever sent to the other person because of an own message.

Never treated as own messages:

- echoes of messages that this plugin sent: the upstream in-memory echo cache, plus the ids of its sends of the last 24 hours, persisted so that a restart does not turn an echo into an own message. The persisted ids are bounded like the stores above, to the newest 5,000: an echo that arrives after 5,000 newer sends counts as an own message, which records history and in `turn` mode starts an owner turn, and sends nothing;
- offline backfill and history sync (only live `notify` upserts count);
- group chats, status and broadcast chats, and the account's own chat;
- reactions, edits, deletes and poll votes.

A message to a chat whose phone number the plugin cannot resolve (an unmapped LID) is skipped.

### The `owner` target

```json5
{
  commands: { ownerAllowFrom: ["whatsapp:+15550000200"] }, // exactly one WhatsApp owner
}
```

The agent writes to the owner with the `message` tool and `target: "owner"` (also `whatsapp:owner`, any case). The model never sees the owner's number:

- The target normalizer and the outbound resolver keep `owner` as it is, so OpenClaw core, the `before_tool_call` and `message_sending` hooks, and the tool result see `to: "owner"`. The resolver admits `owner` whatever `allowFrom` says: the owner is a command owner by definition.
- Only the final transport send resolves `owner` to the WhatsApp entry of `commands.ownerAllowFrom` (`whatsapp:+<number>` or a bare number). Text, media, polls, typing and reactions resolve it the same way. A reply (`replyTo`) to `owner` quotes the message in the owner's chat: the plugin resolves the owner's chat for the quote lookup and passes `owner` on to the send.
- Everything the transport returns to core for such a send names the chat `owner`: `toJid`, receipts, progress results and errors. The owner's number, its chat ids (`<digits>@s.whatsapp.net`, `<digits>@c.us`) and any LID (`<digits>@lid`) become `owner`. An error keeps its class, so partial-delivery recovery works as for any send.
- Zero or several WhatsApp owners: the send fails with `WhatsApp target "owner" needs exactly one WhatsApp owner in commands.ownerAllowFrom; none is configured.` (or `2 are configured.`). The error names no number.
- The plugin's sent-message store records the real chat id, so the echo of a send to `owner` is never an own message. A 👍/👎 reaction on an approval or question prompt sent to `owner` binds to the owner's chat.

Limits:

- `owner` has no outbound session route, because the owner's session key carries the number. OpenClaw therefore writes no delivery mirror of the send into the owner's transcript, and cross-chat send history records only the owner's own sends (below).
- `ownMessages` turns go to the first WhatsApp owner; `owner` needs exactly one.

### Cross-chat send history

No config. Each sender has their own session when `session.dmScope` is `per-account-channel-peer` (or `per-peer`, `per-channel-peer`). When the agent in the owner's direct session (the WhatsApp entry of `commands.ownerAllowFrom`) sends with the `message` tool to another person's direct chat, the plugin appends the delivery to the recipient's native session transcript without starting a turn:

```text
[WhatsApp +15550000300 Thu 2025-10-09T09:10:00Z] Owner's AI agent: Your order A-100 has shipped.
```

- The author is `historyAuthors.ownerAgent` (default `Owner's AI agent`), so the model can distinguish it from a message typed on the phone. An approval prompt or outcome in the approver's chat is written the same way, with `historyAuthors.approval` (default `Approval request`). Media sent with it shows as a placeholder such as `<media:image>`.
- The entry becomes part of the native transcript immediately after delivery is recorded. `ownMessages: "off"` disables recording messages typed on the phone; it does not hide assistant or system entries.
- A send from the recipient's own session is already in that session's transcript, so it is never recorded. The plugin compares the session that made the send with the recipient's direct session as OpenClaw routes an inbound message from that person (`resolveAgentRoute`).
- Only a send from the owner's chat is recorded. A send from anyone else's chat, such as a customer's question the agent forwards to `owner`, can carry that person's words; recorded under the owner's AI agent in another chat, they would be read as the owner's side, with that chat's tools. The owner reads such a forward on the phone, and quoting it brings its text into the owner's turn as a quote.

How it works and its limits:

- The plugin reads the `after_tool_call` hook of the `message` tool: the hook alone carries the session that made the send. The transport send does not: for a tool send, OpenClaw's gateway delivers under the recipient's session. The hook needs no `allowConversationAccess`.
- Cross-chat recording covers `action: "send"` with a settled delivery and a real message ID. Polls, reactions, `upload-file`, groups, newsletters, failed, suppressed and dry-run sends are excluded. Native approval cards and status notices use their own delivered-message producer. Same-session replies remain OpenClaw's responsibility.
- The recorded text is the `message` argument of the tool call, before OpenClaw adds a response prefix.
- The account is the one the send went through. A call that names `accountId` went through that account. A call that names none went through the run's account, as core sends it: the plugin takes the one account on which the sending session is the owner's direct session. When `session.dmScope` leaves the account out of the session key (`per-peer`, `per-channel-peer`) and several WhatsApp accounts exist, no single account matches, and the plugin records nothing rather than guess.
- Ordering: OpenClaw starts `after_tool_call` after the tool returns and does not wait for it. The entry is appended shortly after delivery settles. A concurrent recipient turn can read the transcript before that append completes; the next history read then sees it.
- An owner turn started by `ownMessages` shows no history of the owner's chat. The owner's chat still retains the linked-phone message in the recipient's transcript.

## Development

The code lives in the OpenClaw monorepo, so OpenClaw's own tooling builds and checks it:

```bash
pnpm test extensions/whatsapp                              # the extension's whole suite, monorepo-only tests included
pnpm check:changed --base v2026.10.2 --head HEAD           # OpenClaw's changed-file gate: type checks, lint, ratchets
node --import ./scripts/tsx.mjs extensions/whatsapp/scripts/write-channel-config-schema.mts   # rewrite channelConfigs
```

The plugin leaves OpenClaw's core unchanged. `src/whatsapp-config-schema.ts` is the plugin-local copy of OpenClaw's `channels.whatsapp` schema, which a third-party plugin must ship; `whatsapp-config-schema.test.ts` keeps it equal to OpenClaw's and `openclaw.plugin.json` in sync with it. The plugin's own settings are in `configSchema` of `openclaw.plugin.json` and `src/plugin-config.ts`.

## License

MIT. See `LICENSE` and `NOTICE`.
