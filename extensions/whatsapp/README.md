# whatsapp-for-business

The OpenClaw WhatsApp channel plugin (`@openclaw/whatsapp`, OpenClaw `v2026.10.2`), built from the disciplinedware fork of OpenClaw (github.com/disciplinedware/openclaw). Branch `whatsapp-own-messages-approvals` holds own messages and native approvals in the shape upstream would take them; branch `whatsapp-for-business` adds one packaging commit that publishes them as this package, and then the `owner` target and cross-chat send history. It keeps the channel id `whatsapp`, so routing, session keys, `toolsBySender` keys (`e164:<phone>`) and other plugins see no difference. It changes four things:

| Capability       | Config key                                        | Upstream behavior                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Own messages     | `channels.whatsapp[.accounts.<id>].ownMessages`   | A message that the linked phone itself sends to another person is dropped. The agent never sees it.                                                                                                                                                                                        |
| Native approvals | `channels.whatsapp[.accounts.<id>].execApprovals` | WhatsApp has no `execApprovals` block. Approvers come from `allowFrom`, so with `allowFrom: ["*"]` anyone who can react to the prompt resolves it, the business number included. Native prompts need `approvals.exec` or `approvals.plugin` and go to the chat that the request came from. |
| `owner` target   | `commands.ownerAllowFrom`                         | To write to the owner, the agent must know the owner's number, and the number comes back in the `message` tool result.                                                                                                                                                                     |
| Send history     | none                                              | A `message` send from one chat's session to another chat reaches that chat's transcript as a delivery mirror, which the model never reads: the recipient's next turn does not know what was written to them.                                                                               |

Native approvals follow `channels.telegram.execApprovals`: the same keys, the same approver fallback to `commands.ownerAllowFrom`, the same DM-first delivery. This is a breaking change against upstream: `allowFrom` no longer makes anyone an approver, so a config that relied on it must name the approvers in `execApprovals.approvers` or `commands.ownerAllowFrom`. Without `ownMessages`, own messages behave as upstream. `NOTICE` names the upstream source; `git diff v2026.10.2 whatsapp-for-business -- extensions/whatsapp src/config` shows every change.

## Requirements

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

Install the plugin before you add the keys below to the config: until the plugin is installed, the upstream schema validates `channels.whatsapp` and refuses them.

## Taking over the `whatsapp` channel

The plugin id is `whatsapp-for-business`; the channel id stays `whatsapp`. The manifest declares `channelConfigs.whatsapp.preferOver: ["whatsapp"]`. OpenClaw then validates `channels.whatsapp` with this plugin's schema and does not start the upstream plugin, as long as nobody selected the upstream plugin explicitly.

Explicit selection wins over `preferOver`. Make sure that exactly one owner is selected:

- `openclaw plugins install` writes `plugins.entries.<id>.enabled: true` for every plugin it installs. If the upstream plugin was installed this way, set `plugins.entries.whatsapp.enabled: false` or uninstall it.
- If the upstream plugin is loaded through `plugins.load.paths` and `plugins.allow`, replace `whatsapp` with `whatsapp-for-business` there.
- If both plugins are enabled explicitly, OpenClaw loads both. The first one registers the channel; the gateway log then shows `channel already registered: whatsapp (whatsapp) (plugin=whatsapp-for-business, ...)`.

The linked-device credentials stay where they are (`authDir`), so no new QR link is needed. Plugin-scoped state starts empty, because OpenClaw keys it by plugin id: the durable inbound queue and the approval reaction bindings of the upstream plugin are not carried over.

## Config reference

Both keys can sit at `channels.whatsapp` or at `channels.whatsapp.accounts.<id>`. An account value replaces the root value as a whole. As for every upstream key, values on `accounts.default` are shared defaults for the other accounts. The plugin reads them for each message, so a config change applies without a restart.

### `execApprovals`

```json5
{
  commands: { ownerAllowFrom: ["whatsapp:+15550000200"] }, // the owner, for every channel
  channels: {
    whatsapp: {
      dmPolicy: "open",
      allowFrom: ["*"], // who may talk to the agent
      execApprovals: { approvers: ["+15550000200"] }, // optional when ownerAllowFrom names the owner
    },
  },
}
```

| Key             | Values                                    | Effect                                                                                                                                             |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`       | `"auto"` (default), `true`, `false`       | `"auto"` and `true` turn native approvals on when at least one approver resolves; `false` turns them off.                                          |
| `approvers`     | E.164 numbers                             | Who may approve. Unset or empty: the WhatsApp entries of `commands.ownerAllowFrom` (`whatsapp:+15550000200` or a bare number).                     |
| `target`        | `"dm"` (default), `"channel"`, `"both"`   | Where the prompt goes: the approvers' direct chats, the chat that the request came from, or both. `channel` shows the request to that chat.        |
| `agentFilter`   | agent ids                                 | Only requests of these agents.                                                                                                                     |
| `sessionFilter` | session-key patterns (substring or regex) | Only requests of matching sessions.                                                                                                                |
| `notifyOrigin`  | `true` (default), `false`                 | With `target: "dm"`, whether the chat that the request came from hears that the request went to WhatsApp DMs. `false` keeps a guest's chat silent. |

Authorization:

- Only a resolved approver resolves an exec, plugin (`plugin:` id) or system-agent approval, by a 👍/👎 reaction on the prompt or by `/approve`. Everyone else is refused, the business number and every guest included.
- `allowFrom`, `dmPolicy` and `defaultTo` admit senders and set default targets; they never make an approver.
- No approver resolves: nobody approves in WhatsApp, and `/approve` for an exec request answers that WhatsApp exec approvals are not enabled. The Web UI still approves.
- A recipient of an `approvals.exec` target in mode `targets` or `both` may also approve exec requests, as on Telegram.

Delivery:

- The native runtime of the account handles exec, plugin and system-agent approvals that match the account and the filters, with no `approvals.exec` or `approvals.plugin` config. It sends the prompt, binds the 👍/👎 reaction to that message, and updates the prompt when the approval resolves or expires.
- For a request that came from WhatsApp, OpenClaw's shared forwarder sends no second WhatsApp copy.
- With `target: "dm"`, the chat that the request came from gets OpenClaw's notice `Approval required. I sent the approval request to WhatsApp DMs, not this chat.`, as on Telegram, Discord and Slack. For a request from a guest's chat, the guest sees that notice; `notifyOrigin: false` keeps that chat silent while the approvers still get the prompt.
- If every native delivery of a request fails, OpenClaw sends a delivery-failed notice with the approval id and the `/approve` commands to the chat that the request came from. Only an approver can use it.
- Native prompts go through the plugin's own WhatsApp send path, so the `message_sending` hook does not run for them.
- `approvals.exec` and `approvals.plugin` with WhatsApp targets still work through the shared forwarder, as upstream; the reaction binds to the delivered message and the rules above authorize it.

### `ownMessages`

```json5
{
  commands: { ownerAllowFrom: ["whatsapp:+15550000200"] }, // the owner, as for execApprovals
  channels: {
    whatsapp: {
      ownMessages: "turn",
    },
  },
}
```

An own message is a message that the linked phone itself sends, live, to another person's direct chat: for example, the owner of the business types to a guest on the business phone.

| Value           | Effect                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off` (default) | Upstream behavior: the message is dropped.                                                                                                                                                                                                      |
| `history`       | The message is kept as history of that chat. The next dispatched turn of that chat receives it as a platform-selected history window (`historyKind: "recent"`). No agent run, no send.                                                          |
| `turn`          | The same history, and one agent run in the owner's direct session on this account, as a room event (`InboundEventKind: "room_event"`): the agent observes what the owner said and replies only with the `message` tool, when a reply is useful. |

The owner is the first entry of `commands.ownerAllowFrom` that is `whatsapp:+<number>` or a bare number: the same owner list that `execApprovals` falls back to, picked the way OpenClaw picks the owner route for heartbeat delivery. In `turn` mode without such an entry, the history is kept, no turn runs, and the gateway log says so.

History:

- Pending own messages are kept in plugin state for 24 hours, at most the newest 1,000 across all chats: OpenClaw's bounded keyed store sheds the oldest entries past its `maxEntries`, as for the persistent sent-message caches of Slack and Microsoft Teams. An own message shed early is missing from that chat's history; nothing else changes. A dispatched turn of the chat consumes them; a failed dispatch keeps them for the next turn.
- A turn carries at most `historyLimit` of them (the same limit as group history).
- Each entry has the sender `(self)`, the attribution OpenClaw gives a message the account itself sent in a direct chat, so it reads `(self): <text>`.

The owner turn:

- Its message body is the own message as OpenClaw writes a message the account itself sent in a direct chat (`formatInboundEnvelope` with `fromMe`): the other person's number in the envelope, then `(self):` and the content (text, then a media placeholder such as `<media:image>`):

  ```text
  [WhatsApp +15550000300 Thu 2025-10-09T08:53:20Z] (self): The pool is cleaned on Mondays.
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

No config. Each sender has their own session when `session.dmScope` is `per-account-channel-peer` (or `per-peer`, `per-channel-peer`). When the agent in the owner's direct session (the WhatsApp entry of `commands.ownerAllowFrom`) sends with the `message` tool to another person's direct chat, the plugin records the message as history of the recipient's chat, the same history that `ownMessages` fills. The recipient's next dispatched turn receives it and consumes it:

```text
[WhatsApp +15550000300 Thu 2025-10-09T09:10:00Z] (self): [sent by the assistant from another chat] Your late checkout is approved.
```

- The entry reads `(self):` as every message the account sent, then `[sent by the assistant from another chat]`, so the model tells it from a message typed on the phone. Media sent with it shows as a placeholder such as `<media:image>`.
- The same rules as for own messages apply: 24 hours, at most 1,000 pending entries across all chats, at most `historyLimit` per turn, kept when the dispatch fails. The assistant's entries reach the turn whatever `ownMessages` is. With `ownMessages: "off"`, entries typed on the phone and stored before the switch are consumed by the next turn without being shown.
- A send from the recipient's own session is already in that session's transcript, so it is never recorded. The plugin compares the session that made the send with the recipient's direct session as OpenClaw routes an inbound message from that person (`resolveAgentRoute`).
- Only a send from the owner's chat is recorded. A send from anyone else's chat, such as a customer's question the agent forwards to `owner`, can carry that person's words; recorded as the assistant's own message in another chat, they would be read as the assistant's, with that chat's tools. The owner reads such a forward on the phone, and quoting it brings its text into the owner's turn as a quote.

How it works and its limits:

- The plugin reads the `after_tool_call` hook of the `message` tool: the hook alone carries the session that made the send. The transport send does not: for a tool send, OpenClaw's gateway delivers under the recipient's session. The hook needs no `allowConversationAccess`.
- Only `action: "send"` with a settled delivery counts. Polls, reactions, `upload-file`, sends to groups and newsletters, failed, suppressed and dry-run sends are not recorded; nor are messages that OpenClaw sends outside the `message` tool (cron delivery, approval prompts, replies).
- The recorded text is the `message` argument of the tool call, before OpenClaw adds a response prefix.
- The account is the one the send went through. A call that names `accountId` went through that account. A call that names none went through the run's account, as core sends it: the plugin takes the one account on which the sending session is the owner's direct session. When `session.dmScope` leaves the account out of the session key (`per-peer`, `per-channel-peer`) and several WhatsApp accounts exist, no single account matches, and the plugin records nothing rather than guess.
- Ordering: OpenClaw starts `after_tool_call` after the tool returns and does not wait for it, and no plugin path that runs before the send settles knows the sending session. So the entry is stored shortly after the send, not before it. A turn of the recipient that reads its history before the entry is stored does not show it; the turn consumes only the entries it read, so the entry stays pending and the recipient's next turn shows it. An entry is never lost to this race and never shown twice.
- An owner turn started by `ownMessages` shows no history of the owner's chat; the next message that the owner writes to the business number shows it.

## Development

The code lives in the OpenClaw monorepo, so OpenClaw's own tooling builds and checks it:

```bash
pnpm test extensions/whatsapp                              # the extension's whole suite, monorepo-only tests included
pnpm check:changed --base v2026.10.2 --head HEAD           # OpenClaw's changed-file gate: type checks, lint, ratchets
node --import ./scripts/tsx.mjs extensions/whatsapp/scripts/write-channel-config-schema.mts   # rewrite channelConfigs
```

On branch `whatsapp-own-messages-approvals` the schema lives in core (`src/config/zod-schema.providers-whatsapp.ts`). The packaging commit adds the plugin-local copy `src/whatsapp-config-schema.ts`, because a third-party plugin defines its own schema and a stock host's copy lacks `execApprovals` and `ownMessages`. `whatsapp-config-schema.test.ts` keeps the copy equal to core and `openclaw.plugin.json` in sync with it.

## License

MIT. See `LICENSE` and `NOTICE`.
