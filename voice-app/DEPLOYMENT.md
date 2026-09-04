# Deployment

Running claude-phone-local beyond a first test. For the quickstart see
[../README.md](../README.md); for architecture see [../CLAUDE.md](../CLAUDE.md).

## Topology

Two moving parts:

| Where | What | Why there |
|---|---|---|
| Container | drachtio, FreeSWITCH, voice-app, STT, TTS | one image, supervisord, all loopback |
| Host | `claude-api-server` → `claude` CLI | the CLI is installed and authenticated on the host |

They meet at exactly one place: `host.docker.internal:3333`.

## Ports

| Port | Proto | Published | Purpose |
|---|---|---|---|
| 5070 | UDP/TCP | yes | drachtio SIP — the PBX talks to this |
| 30000–30100 | UDP | yes | RTP media |
| 3000 | TCP | yes | voice-app HTTP API |
| 5080 | UDP/TCP | **no** | FreeSWITCH SIP — internal only |
| 8021 | TCP | **no** | FreeSWITCH ESL — internal only |
| 9001 / 9002 | TCP | loopback | STT / TTS sidecars |
| 3333 | TCP | host | claude-api-server |

5080 and 8021 are deliberately unpublished: drachtio reaches FreeSWITCH inside
the container. Publishing them would expose your media server to the LAN.

RTP is **30000–30100** because the 3CX SBC uses 20000–20099; overlapping the two
breaks audio.

### Firewall

```powershell
New-NetFirewallRule -DisplayName "claude-phone SIP" -Direction Inbound `
  -Protocol UDP -LocalPort 5070 -Action Allow
New-NetFirewallRule -DisplayName "claude-phone RTP" -Direction Inbound `
  -Protocol UDP -LocalPort 30000-30100 -Action Allow
```

Do **not** open 3333. See [Security](#security).

## Networking and NAT

Docker Desktop cannot do real host networking on Windows, so the compose file
uses a bridge with published ports. FreeSWITCH therefore cannot discover your
LAN address and must be told it.

The critical detail — SIP and RTP advertise **different** addresses:

```
ext_rtp_ip = EXTERNAL_IP     e.g. 172.16.14.225   (so the SBC reaches the media)
ext_sip_ip = container IP    e.g. 172.18.0.2      (so drachtio reaches FreeSWITCH)
```

`docker/entrypoint.sh` computes the container IP at boot. Verify after a deploy:

```bash
docker logs claude-phone | grep "will advertise"
# [bootstrap] FreeSWITCH SIP will advertise 172.18.0.2; RTP will advertise 172.16.14.225
```

FreeSWITCH's `nat.auto` ACL also has to be defused — it treats `172.16.0.0/12`
as local, which swallows both a `172.16.x` LAN and the `172.18.x` Docker bridge.
The Dockerfile patches `mrf.xml` with `local-network-acl = none` at build time.

## Persistent state

Everything that must survive a restart is on the `./data` bind mount:

```
data/voices/          Piper models      (~195 MB)
data/models/          Whisper cache     (~1.9 GB)
data/config/          devices.json      (your SIP credentials)
data/audio/           generated speech  (scratch, safe to clear)
```

Back up `data/config/`. The rest re-downloads on its own.

A healthy restart is under a minute and re-downloads nothing:

```
[bootstrap] voice en_US-lessac-medium already present
[bootstrap] whisper model cached
[bootstrap] devices.json already present (left untouched)
```

## Running the host wrapper as a service

`claude-api-server` must stay up or calls connect and then fail to answer.

**Windows (NSSM):**

```powershell
nssm install claude-api "C:\Program Files\nodejs\node.exe" `
  "C:\path\to\claude-api-server\server.js"
# Default is claude-sonnet-5. OmniRoute / custom API: CLAUDE_MODEL=default
nssm set claude-api AppEnvironmentExtra CLAUDE_MODEL=claude-sonnet-5
nssm start claude-api
```

**Linux (systemd):** `/etc/systemd/system/claude-api.service`

```ini
[Unit]
Description=claude-phone API server
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/claude-api-server
# Default is claude-sonnet-5. OmniRoute / custom API: CLAUDE_MODEL=default
Environment=CLAUDE_MODEL=claude-sonnet-5
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

It must run **as the user whose Claude Code is authenticated** — it inherits
that login and config.

## Resource sizing

| | Idle | Per call |
|---|---|---|
| RAM | ~2.5 GB (Whisper `medium` resident) | +200 MB |
| CPU | negligible | 1–2 cores during transcription |
| Disk | ~2.2 GB in `./data` | a few MB of audio |

`WHISPER_MODEL` dominates memory: `small` ~1 GB, `medium` ~2.5 GB,
`large-v3` ~5 GB. Transcription is CPU-bound — it is the largest fixed part of
response latency.

## Monitoring

```bash
docker compose ps
docker logs claude-phone 2>&1 | grep -E "MULTI-REGISTRAR|CALL |error"
curl http://127.0.0.1:3000/api/devices     # voice-app alive
curl http://127.0.0.1:3333/health          # host wrapper alive
```

Supervisord restarts any of the five processes that dies. Repeated restarts show
as `spawned:` lines without a matching `entered RUNNING state`.

SIP registration refreshes every ~27 minutes; losing it silently is the usual
cause of "calls stopped arriving".

## Security

`claude-api-server` runs the CLI with `--dangerously-skip-permissions`: no
prompts, every tool, full access to the host as your user, with your normal
`~/.claude` config including MCP servers and plugins.

- **Bind 3333 to localhost.** Docker Desktop still reaches it through
  `host.docker.internal`. On a LAN-exposed `0.0.0.0` bind, anyone who can route
  to the port can execute commands as you.
- **Never commit** `data/config/devices.json` or `.env`.
- Consider a dedicated 3CX extension with restricted inbound routing so only
  your own extensions can dial it.

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

`./data` is untouched, so no models are re-downloaded and `devices.json` is
preserved. Roll back with `docker compose -f docker-compose.multi.yml up -d`
(the previous five-container layout) if a build regresses.
