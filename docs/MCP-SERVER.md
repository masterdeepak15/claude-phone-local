# MCP Server — let Claude phone you

Gives a Claude Code session a phone. It can ring you mid-task, say why, and —
in conversation mode — talk the decision through before carrying on.

Useful when Claude is doing something long and hits a fork in the road: a
migration that needs a call, a deploy that wants confirmation, a test suite that
went red in a way worth discussing.

## How it fits

The MCP server does **no SIP work**. It is a thin wrapper over the voice-app
HTTP API that already existed:

```
Claude Code session
      │  MCP (stdio)
      ▼
mcp-server/index.js
      │  HTTP
      ▼
voice-app /api/outbound-call   →  drachtio → FreeSWITCH → 3CX → your phone
```

## Install

```bash
cd mcp-server && npm install

claude mcp add claude-phone --scope user \
  --env VOICE_APP_URL=http://127.0.0.1:3000 \
  --env PHONE_DEFAULT_TO=17510 \
  -- node /absolute/path/to/mcp-server/index.js
```

Then **restart Claude Code** and confirm:

```bash
claude mcp list
# claude-phone: node …/mcp-server/index.js - ✔ Connected
```

| Env | Purpose |
|---|---|
| `VOICE_APP_URL` | Where voice-app listens (default `http://127.0.0.1:3000`) |
| `PHONE_DEFAULT_TO` | Number/extension to ring when `to` is omitted |

## Tools

### `call_me`

Rings you and speaks a message.

| Arg | Required | Notes |
|---|---|---|
| `message` | yes | What to say. One or two spoken sentences, no markdown. |
| `mode` | no | `announce` (say it, hang up) or `converse` (stay on the line) |
| `to` | no | Defaults to `PHONE_DEFAULT_TO` |
| `context` | no | Background so the voice agent can field follow-ups |

### `call_status`

Poll a call by `callId` — whether it is still up and how it ended.

### `hangup`

End a call that is still in progress.

## Using it

Just ask in plain language:

> "Run the migration, and call me if anything needs a decision."

> "This test suite takes 20 minutes — phone me when it finishes with a summary."

Claude picks the tool itself. For a back-and-forth, ask for conversation mode:

> "Call me and talk me through the options — I want to answer, not just listen."

## Writing a good message

It is **spoken aloud**, so:

- Keep it to one or two sentences.
- No markdown, code blocks, paths, or long identifiers — they sound terrible.
- Lead with the decision, not the backstory:
  *"The migration is ready but will drop two columns — should I continue?"*
- Use `context` for the detail. It never gets read out, but the voice agent can
  draw on it when you ask a follow-up question.

## Notes and limits

- **voice-app must be running** (`docker compose up -d`) — the MCP server only
  proxies to it.
- **`announce` does not wait.** It returns as soon as the call starts. Poll
  `call_status` if you need the outcome.
- **If you do not answer**, the call ends on the ring timeout
  (`OUTBOUND_RING_TIMEOUT`, default 30s) and `call_status` reports it. Claude
  should carry on rather than block.
- Errors come back as tool failures with the HTTP status, so Claude can react
  instead of crashing.

## Troubleshooting

| Symptom | Check |
|---|---|
| `✘ Failed to connect` in `claude mcp list` | `cd mcp-server && npm install`; use an absolute path in the registration |
| `claude-phone: 500 …` | Is voice-app up? `curl http://127.0.0.1:3000/api/devices` |
| Phone never rings | SIP registration — `docker logs claude-phone \| grep MULTI-REGISTRAR` |
| Rings, then silence | Same RTP/SDP checks as inbound: [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
