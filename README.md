<p align="center">
  <img src="assets/logo.png" alt="Claude Phone" width="200">
</p>

# Claude Phone (Local)

Voice interface for Claude Code via SIP/3CX. Call your AI, and your AI can call you.

> **Based on [theNetworkChuck/claude-phone](https://github.com/theNetworkChuck/claude-phone).**
> This is a modified fork of NetworkChuck's original project. All credit for the
> original design and implementation goes to him — see [Credits](#credits).
>
> **What this fork changes:** speech runs fully offline (faster-whisper + Piper
> instead of OpenAI Whisper and ElevenLabs, so no API keys), English/Hindi/Marathi
> with automatic language detection, barge-in so you can interrupt mid-sentence,
> an MCP server so Claude can phone *you*, and the whole stack in a **single
> Docker container** with a persistent `./data` volume.

## What is this?

Claude Phone gives your Claude Code installation a phone number:

- **Inbound** — call an extension and talk to Claude. Ask it to check your PC,
  run commands, or answer questions. It has real shell access to the host.
- **Outbound** — Claude can call *you* when it needs a decision, then talk it
  through. Available over HTTP or as an [MCP tool](docs/MCP-SERVER.md).

Everything speech-related is **local and free**. The only paid piece is the
Claude Code CLI itself.

## Prerequisites

Manual, one time:

- **Docker Desktop** (WSL2 backend on Windows)
- **Claude Code CLI**, logged in — `claude --version`
- **Node.js 18+** on the host, for `claude-api-server`
- A **SIP extension** on 3CX (or any SIP PBX)

Everything else — speech models, voices, device config — is downloaded and
generated automatically on first run.

## Quick start

The npm CLI is the recommended path — it installs, prompts you through 3CX/
device config, and starts everything (including the host-side Claude wrapper)
for you:

```bash
npm install -g claude-phone-local
claude-phone setup     # interactive: 3CX domain, extension, speech mode, etc.
claude-phone start     # builds + launches everything, including claude-api-server
```

When you see `✓ All services running!` with your extension listed, call it.
Full prompt-by-prompt walkthrough (3CX extension → SBC → Docker → npm install
→ setup → start): **[docs/SETUP.md](docs/SETUP.md)**.

<details>
<summary>Manual / dev setup (git clone + docker compose)</summary>

For local development on this repo, or if you'd rather manage `.env` and
`docker compose` by hand instead of the CLI:

```bash
git clone <your-fork> claude-phone-local
cd claude-phone-local
cp .env.example .env
```

Edit `.env` — the three that matter:

```bash
EXTERNAL_IP=172.16.14.225      # this PC's LAN IP (ipconfig / ip addr)
SIP_REGISTRAR=172.16.14.225    # your LOCAL 3CX SBC, not the cloud domain
SIP_EXTENSION=17512            # plus SIP_AUTH_ID and SIP_PASSWORD
```

Start it:

```bash
docker compose up -d --build          # first run downloads ~2GB of models
docker compose logs -f                # watch the bootstrap
```

In a second terminal, start the host-side Claude wrapper:

```bash
cd claude-api-server
CLAUDE_MODEL=claude-sonnet-5 node server.js
```

When you see this, call your extension:

```
[MULTI-REGISTRAR] Maya SUCCESS - Registered as ext 17512
```

</details>

## Architecture

One container, one host process:

```
Phone → 3CX cloud → 3CX SBC (HOST :5060)
                      │
        ┌─────────────▼───────────────────────────┐
        │  claude-phone container                 │
        │  drachtio · FreeSWITCH · voice-app      │
        │  faster-whisper · Piper                 │
        └─────────────┬───────────────────────────┘
                      │ host.docker.internal:3333
                      ▼
        claude-api-server (HOST) → claude.exe (HOST)
```

Inside the container everything talks over `127.0.0.1`. Persistent state lives
in `./data` — models, voices and config survive `docker compose down`.

See [CLAUDE.md](CLAUDE.md) for the full architecture and design decisions.

## Languages

English, Hindi and Marathi, detected per utterance — switch language mid-call
and she follows, replying in the same language with a matching voice.

```bash
STT_LANGUAGE=auto
SUPPORTED_LANGS=en,hi,mr
```

Details and the accuracy/speed trade-off: [docs/LANGUAGES.md](docs/LANGUAGES.md).

## Talking to her

- **Interrupt any time.** Start speaking and she stops — no waiting for her to
  finish.
- **Hang up by saying so:** "goodbye", "bye", "end call", "close the call",
  "बंद करो", "ठेवतो".
- **One session per call.** The whole call is a single Claude conversation, so
  she remembers what you said two questions ago.
- **She fills the silence** with a soft hold tone and the occasional spoken
  line while she works, instead of going dead.

## Claude calling you

Register the [MCP server](docs/MCP-SERVER.md) and ask in plain language:

> "Run the migration and call me if anything needs a decision."

```bash
cd mcp-server && npm install
claude mcp add claude-phone --scope user \
  --env PHONE_DEFAULT_TO=17510 \
  -- node /absolute/path/to/mcp-server/index.js
```

## What can you do with this?

Since Claude has real shell access to the host PC, "call your extension" is
really "call a machine that can run anything on your network." Some
examples:

### Home automation

- **"Turn off the living room lights and lock the front door."** — if your
  smart home exposes a CLI, API, or Home Assistant instance on the same
  network, Claude can hit it directly. No separate voice assistant skill to
  write.
- **"Is the garage door open?"** — ask a status question from bed without
  reaching for an app.
- **"Call me if the washing machine cycle finishes"** — Claude polls
  something (a smart plug's power draw, a sensor) in the background while
  doing other work, then rings you via the [MCP server](docs/MCP-SERVER.md)
  when it's done.
- **Multilingual household** — parents ask in Hindi or Marathi, kids ask in
  English, same extension, same session — see [Languages](#languages).

### Inside a company / office

- **"What's the status of the nightly backup job?"** — ask from your car on
  the way in, get a real answer pulled from actual logs, not a canned reply.
- **"Restart the staging server and let me know when it's back up."** —
  fire-and-forget a real ops task, then Claude calls you back when it's
  actually done (see [Claude calling you](#claude-calling-you)) instead of
  you babysitting a terminal.
- **On-call triage** — "walk me through what's alerting right now" while
  driving, hands-free, with Claude actually querying your monitoring stack
  instead of reading a static runbook.
- **A shared team extension** — dial in from any phone (no app, no VPN
  client) to ask about deploy status, check disk space on a shared box, or
  kick off a known-safe script — useful when someone's laptop isn't handy but
  a phone is.
- **Slack handoff for long tasks** — ask something that takes a while ("audit
  every repo for hardcoded secrets"), hang up, and have the results posted to
  a Slack channel instead of waiting on hold.

None of this requires a PBX-side integration or webhook plumbing — it's the
same shell access you'd have SSH'd into the box yourself, just reachable from
any phone that can dial the extension.

## Configuration

Common knobs in `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `EXTERNAL_IP` | — | This PC's LAN IP, for RTP |
| `WHISPER_MODEL` | `medium` | `small` is ~3x faster, weaker on Marathi |
| `STT_LANGUAGE` | `auto` | Or pin `en` / `hi` / `mr` |
| `CLAUDE_TIMEOUT` | `180` | Seconds before giving up |
| `VAD_NOISE_MULT` | `2.5` | How far above the noise floor counts as speech |
| `BARGE_MULT` | `1.6` | How hard it is to interrupt her |
| `PHONE_ENABLE_MCP` | off | Give the phone agent your MCP tools (slower) |

## API endpoints

**voice-app (3000)**

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/outbound-call` | Start an outbound call |
| GET | `/api/call/:id` | Call status |
| POST | `/api/call/:id/hangup` | End a call |
| GET | `/api/devices` | List configured devices |

**claude-api-server (3333, host)**

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/ask` | Send a prompt |
| GET | `/health` | Health check |

## Security

`claude-api-server` runs the CLI with `--dangerously-skip-permissions`. That
means **no prompts, all tools, full access to this PC as your user**, with your
normal `~/.claude` config. Anyone who can reach port 3333 can run commands as
you — keep it bound to localhost.

Never commit `data/config/devices.json` or `.env`; both are gitignored, and a
`prepublishOnly` guard blocks publishing if they would ship.

## Troubleshooting

```bash
docker compose logs -f
docker logs claude-phone 2>&1 | grep -Ei "CALL |error|503"
curl http://127.0.0.1:3333/health
```

Straight to voicemail, connected-but-silent, slow answers, restart loops and
more: **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)**.

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — full walkthrough: 3CX extension → SBC →
  Docker → npm install → `claude-phone setup` → `claude-phone start`
- [CLAUDE.md](CLAUDE.md) — architecture and design decisions
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — every failure mode we hit
- [docs/LANGUAGES.md](docs/LANGUAGES.md) — Hindi/Marathi setup
- [docs/MCP-SERVER.md](docs/MCP-SERVER.md) — letting Claude call you
- [README-LOCAL-MODE.md](README-LOCAL-MODE.md) — Windows + 3CX specifics
- [voice-app/README-OUTBOUND.md](voice-app/README-OUTBOUND.md) — outbound API
- [voice-app/DEPLOYMENT.md](voice-app/DEPLOYMENT.md) — production notes
- [cli/README.md](cli/README.md) — CLI reference

## License

MIT — same as the original project.

## Credits

This project is a fork of **[claude-phone by NetworkChuck](https://github.com/theNetworkChuck/claude-phone)**
(`https://github.com/theNetworkChuck/claude-phone.git`). The original concept,
SIP/3CX integration and conversation design are his work — this fork only adapts
it for fully-offline speech and multilingual use.

If you find this useful, go support the original:

- Original repository: <https://github.com/theNetworkChuck/claude-phone>
- NetworkChuck on YouTube: <https://www.youtube.com/@NetworkChuck>

### Changes in this fork

| Area | Original | This fork |
|------|----------|-----------|
| STT | OpenAI Whisper API (key required) | faster-whisper, local (no key) |
| TTS | ElevenLabs API (key required) | Piper, local (no key) |
| Languages | English | English, Hindi, Marathi (auto-detected) |
| Containers | Multiple services | Single container via supervisord |
| Persistence | — | `./data` volume; models survive restarts |
| Setup | Manual model/config steps | Automated on first run |
| Conversation | Wait for her to finish | Barge-in — interrupt any time |
| Outbound | HTTP API | HTTP API + MCP server |

Cloud STT/TTS remain available as an opt-in (`STT_MODE=cloud` / `TTS_MODE=cloud`)
for anyone who prefers the original behaviour.
