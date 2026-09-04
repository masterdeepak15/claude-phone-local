@AGENTS.md

# Claude Phone (Local)

Voice interface for Claude Code over SIP/3CX, with **fully offline speech**.
Call your AI; your AI can call you.

Fork of [theNetworkChuck/claude-phone](https://github.com/theNetworkChuck/claude-phone) —
see [Credits](README.md#credits).

## What this fork changes

| Area | Upstream | Here |
|------|----------|------|
| STT | OpenAI Whisper API | faster-whisper, local, no key |
| TTS | ElevenLabs API | Piper, local, no key |
| Languages | English | English + Hindi + Marathi, auto-detected |
| Containers | 5 services | **1 container** (supervisord) |
| State | — | `./data` volume, survives restarts |
| Interruption | — | barge-in: talk over her and she stops |
| Outbound | HTTP API | HTTP API **+ MCP server** |

## Architecture

Two processes, one boundary.

```
Phone → 3CX cloud → 3CX SBC (HOST :5060)
                      │  published port
        ┌─────────────▼───────────────────────────┐
        │  claude-phone container (supervisord)   │
        │                                         │
        │  drachtio       :5070   SIP             │
        │  FreeSWITCH     :5080   media           │
        │                 :30000-30100  RTP       │
        │  voice-app      :3000   call logic      │
        │                 :3001   audio WebSocket │
        │  faster-whisper :9001   STT  (loopback) │
        │  Piper          :9002   TTS  (loopback) │
        └─────────────┬───────────────────────────┘
                      │ host.docker.internal:3333
                      ▼
        claude-api-server (HOST) → claude.exe (HOST)
```

**Everything inside the container talks over 127.0.0.1.** There is no container
DNS to misconfigure — that was the single largest source of bugs in the old
five-container layout.

### The two IPs that matter

FreeSWITCH must advertise **different addresses for signalling and media**:

| Channel | Address | Why |
|---|---|---|
| SIP (`ext-sip-ip`) | container IP, e.g. `172.18.0.2` | drachtio shares the network namespace; FreeSWITCH binds sofia to the container IP, never loopback |
| RTP (`ext-rtp-ip`) | `EXTERNAL_IP` — the PC's LAN IP | the 3CX SBC is a native Windows process and must reach the media |

Getting either wrong gives a `503` (SIP) or a connected call with no audio (RTP).
The container IP is computed at runtime in `docker/entrypoint.sh`.

## Tech stack

| Component | Technology |
|-----------|------------|
| Language | Node.js (CommonJS in voice-app, ESM in cli/mcp-server) |
| SIP | drachtio-srf |
| Media | FreeSWITCH via drachtio-fsmrf |
| STT | faster-whisper (local) or OpenAI (`STT_MODE=cloud`) |
| TTS | Piper (local) or ElevenLabs (`TTS_MODE=cloud`) |
| Backend | Claude Code CLI via HTTP wrapper |
| Container | Docker Compose, single image |

## Directory structure

```
claude-phone-local/
├── Dockerfile                  # the single unified image
├── docker-compose.yml          # one service, ./data volume
├── docker-compose.multi.yml    # previous 5-container layout (fallback)
├── docker/
│   ├── entrypoint.sh           # bootstrap: models, config, then supervisord
│   └── supervisord.conf        # the five processes
│
├── data/                       # gitignored, survives restarts
│   ├── voices/                 # Piper models (auto-downloaded)
│   ├── models/                 # Whisper cache (auto-downloaded)
│   ├── config/devices.json     # SIP credentials — NEVER commit
│   └── audio/                  # generated speech (scratch)
│
├── voice-app/                  # call logic (runs in container)
│   ├── lib/
│   │   ├── sip-handler.js      # inbound calls + conversation loop
│   │   ├── audio-fork.js       # WebSocket audio, VAD, barge-in
│   │   ├── conversation-loop.js# shared loop (outbound)
│   │   ├── whisper-client.js   # STT client, language detection
│   │   ├── tts-service.js      # TTS client
│   │   ├── claude-bridge.js    # HTTP client to claude-api-server
│   │   ├── outbound-routes.js  # POST /api/outbound-call
│   │   └── device-registry.js  # devices.json loader
│   └── static/                 # beeps + hold music
│
├── claude-api-server/          # runs on the HOST, wraps claude.exe
├── mcp-server/                 # MCP: lets Claude Code phone the user
├── stt-local/  tts-local/      # sidecar servers (baked into the image)
├── cli/                        # claude-phone CLI
└── docs/
```

## Commands

```bash
docker compose build && docker compose up -d   # build + run
docker compose logs -f                         # follow logs
docker compose down                            # stop

# host-side Claude wrapper (must be running for answers)
cd claude-api-server && node server.js
# OmniRoute / custom API: CLAUDE_MODEL=default  (or a model id your proxy supports)

# fall back to the old 5-container layout
docker compose -f docker-compose.multi.yml up -d
```

## Key design decisions

1. **One container, supervisord** — this is a single-user appliance, not a
   scalable service. Loopback beats container DNS here.
2. **`./data` bind mount** — models are ~2 GB; re-downloading on restart is
   unacceptable. Bootstrap is idempotent and fetches only what is missing.
3. **SIP and RTP advertise different IPs** — see above.
4. **`local-network-acl = none`** in `mrf.xml` — FreeSWITCH's `nat.auto` treats
   `172.16.0.0/12` as local, and both the LAN (`172.16.x`) and the Docker bridge
   (`172.18.x`) fall inside it, so it skipped external-IP substitution and put the
   container IP in the SDP. Patched at build time in the Dockerfile.
5. **Adaptive VAD** — fixed thresholds assume digital silence between words. A PBX
   line carries a noise floor (RMS 1000–2500) above any fixed threshold, so
   end-of-speech never fired. The floor is learned as a rolling 20th percentile.
6. **MCP disabled for phone queries** (`--strict-mcp-config`) — each turn spawns a
   fresh CLI that would otherwise dial every configured MCP server, including
   remote ones that time out. Cost ~30s per answer. Set `PHONE_ENABLE_MCP=1` to
   re-enable.
7. **Session per call** — `--session-id` on turn 1, `--resume` after, so one call
   is one continuous Claude conversation.
8. **CommonJS in voice-app** — drachtio ecosystem compatibility.

## Security

`claude-api-server` runs the CLI with `--dangerously-skip-permissions`: no
prompts, all tools, full access to the host PC as your user, and your normal
`~/.claude` config. Anyone who can reach it can run commands as you.

- Keep port **3333 bound to localhost** — Docker Desktop still reaches it via
  `host.docker.internal`.
- **Never commit** `data/config/devices.json` or `.env` (both gitignored).
- `prepublishOnly` blocks publishing if secrets or models would ship.

## Environment

See `.env.example`. The ones that matter:

| Variable | Purpose |
|----------|---------|
| `EXTERNAL_IP` | This PC's LAN IP — the RTP address 3CX uses |
| `SIP_REGISTRAR` | The **local** 3CX SBC IP, not the cloud domain |
| `DRACHTIO_SIP_PORT` | 5070 (the SBC owns 5060) |
| `CLAUDE_API_URL` | `http://host.docker.internal:3333` |
| `CLAUDE_MODEL` | Model for phone turns. Default `claude-sonnet-5`. Set to `default` (or a proxy model id) for OmniRoute / custom APIs |
| `ANTHROPIC_BASE_URL` | Custom / free API proxy (OmniRoute). When set, `ANTHROPIC_API_KEY` is kept for proxy auth |
| `CLAUDE_TIMEOUT` | Seconds before giving up (default 180) |
| `WHISPER_MODEL` | `medium` for Hindi/Marathi, `small` for speed |
| `STT_LANGUAGE` | `auto` to detect the language per utterance |
| `SUPPORTED_LANGS` | Languages we will answer in (`en,hi,mr`) |
| `LANG_VOICE_MAP` | JSON, language code → Piper voice |
| `VAD_NOISE_MULT` | How far above the noise floor counts as speech |
| `BARGE_MULT` / `BARGE_MIN_MS` | How hard it is to interrupt her |
| `KEEPALIVE_SPEAK_EVERY` | Speak every Nth hold-music round |

## Docs

- [README.md](README.md) — quickstart and credits
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — every failure mode we hit
- [docs/MCP-SERVER.md](docs/MCP-SERVER.md) — letting Claude call you
- [docs/LANGUAGES.md](docs/LANGUAGES.md) — Hindi/Marathi setup
- [voice-app/DEPLOYMENT.md](voice-app/DEPLOYMENT.md) — production notes
- [voice-app/README-OUTBOUND.md](voice-app/README-OUTBOUND.md) — outbound API

<!-- gortex:communities:start -->
## Codebase Overview (generated by Gortex)

- **Languages:** javascript (primary), , bash, contract, dockerfile, gitattributes, gitignore, go, image, js, json, markdown, py, python, yaml
- **Most-referenced symbols:** `log` (729 usages), `trim` (77 usages), `info` (68 usages), `push` (52 usages), `includes` (45 usages), `error` (39 usages), `warn` (33 usages), `split` (32 usages), `match` (27 usages), `toLowerCase` (24 usages)
- **Graph size:** 1579 nodes, 7161 edges
- **Breakdown:** 54 builtins, 1 config_keys, 89 contracts, 129 docs, 121 files, 360 functions, 17 images, 10 imports, 61 methods, 197 modules, 4 params, 3 strings, 1 todos, 10 types, 522 variables

## MANDATORY: Use Gortex MCP tools instead of Read/Grep/Glob

Gortex is running as an MCP server. You **MUST** prefer graph queries over file reads on every task in this repo — `search_symbols`, `find_usages`, `get_symbol_source`, `get_editing_context`, `smart_context`, `edit_symbol` / `edit_file` / `rename_symbol` / `batch_edit`. Hook posture is configurable; follow every Gortex hook instruction even when `Read` / `Grep` / `Glob` remain callable. The full per-tool catalog loads via `tools/list` — not restated here.

### Calibration: the graph narrows scope, source confirms behavior

The mandate above stands — but graph queries *narrow scope*, they do not *replace reading the implementation*. The graph tells you **where** the logic lives and **what** connects to it; the source tells you **how** it behaves. For the symbol you are about to change or depend on, read its full body with `get_symbol_source` — do not act on a one-line summary alone.

Be especially deliberate with **behavior-critical code** — database migrations, retry / fallback / error-recovery paths, compatibility shims, concurrency-sensitive sections, and the tests that pin them. For these, call `get_symbol_source` and read the real implementation; never pass `compress_bodies:true`, which elides exactly the branches that carry the risk. Reserve compressed bodies and graph summaries for breadth (surveying many symbols); use full source for the few you are about to commit to.

## Required workflow (every task on this repo)

These are not suggestions — run each step at the trigger.

1. Confirm the daemon is up with `index_health` (cheap liveness + scope). Call `graph_stats` only when you actually need node/edge counts or `per_repo` orientation — it returns a large payload and can block during warmup.
2. If `total_nodes` is 0, **call** `index_repository` with `"."` before anything else.
3. In multi-repo mode, **call** `get_active_project` to check scope; use `set_active_project` to switch.
4. Open a non-trivial task with `smart_context` for orientation. For a single known symbol or file, go straight to `search_symbols` / `get_symbol_source` — don't front-load `smart_context` before every read.
5. Before editing a file, **call** `get_editing_context` on it first.
6. Before changing any function signature, **call** `verify_change` to catch broken callers and interface implementors (cross-repo).
7. For any refactor, **call** `get_edit_plan` then `batch_edit` to apply atomically.
8. Verify with the project's real build/test. Reserve `check_guards` for guard-relevant changes and `get_test_targets` to find the tests covering a substantive change — not mechanically after every edit.

<!-- gortex:communities:end -->
