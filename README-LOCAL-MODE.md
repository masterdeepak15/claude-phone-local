# Windows + 3CX setup

Platform specifics for running claude-phone-local on a Windows PC with Docker
Desktop and a native 3CX SBC. For the general quickstart see
[README.md](README.md).

> Most of what used to live here — downloading Piper voices, fetching the
> Whisper model, hand-writing `devices.json` — is now automatic on first run.
> What remains is the part only you can do: networking and 3CX.

## Why the container cannot use host networking

Docker Desktop on Windows runs containers inside a hidden VM, so
`network_mode: host` does not give you the host's interfaces. The compose file
uses a bridge network with published ports instead.

The consequence that matters: **FreeSWITCH must be told your LAN IP explicitly**,
because it cannot see it. That is what `EXTERNAL_IP` is for.

## 1. Find your LAN IP

```powershell
ipconfig
```

Take the IPv4 address of your active adapter — for example `172.16.14.225`. Put
it in `.env`:

```bash
EXTERNAL_IP=172.16.14.225
```

If this is wrong, calls connect but carry no audio.

## 2. Port 5060 belongs to the SBC

If the 3CX SBC runs on this same PC it already owns UDP 5060, so drachtio uses
**5070**:

```bash
DRACHTIO_SIP_PORT=5070
```

This is already the default. Point the 3CX extension at `<your-ip>:5070`.

## 3. Register against the local SBC, not the cloud

This trips people up. `SIP_DOMAIN` is your *identity*; `SIP_REGISTRAR` is where
REGISTER is actually sent — the SBC on your LAN:

```bash
SIP_DOMAIN=1752.3cx.cloud       # identity, appears in From/To
SIP_REGISTRAR=172.16.14.225     # the local SBC
SIP_REGISTRAR_PORT=5060
```

Registering straight against the cloud domain returns **403 Invalid credentials**.

## 4. Windows Firewall

Allow inbound on the ports Docker publishes:

```powershell
New-NetFirewallRule -DisplayName "claude-phone SIP" -Direction Inbound `
  -Protocol UDP -LocalPort 5070 -Action Allow
New-NetFirewallRule -DisplayName "claude-phone RTP" -Direction Inbound `
  -Protocol UDP -LocalPort 30000-30100 -Action Allow
```

RTP uses **30000–30100** deliberately — the 3CX SBC uses 20000–20099, and
overlapping them breaks audio.

## 5. 3CX extension

Create a SIP extension and copy its credentials into `.env`:

```bash
SIP_EXTENSION=17512
SIP_AUTH_ID=<authentication id>
SIP_PASSWORD=<authentication password>
```

On first run these become `data/config/devices.json`. **That file holds live
credentials and is gitignored — never commit it.**

## 6. Start

```bash
docker compose up -d --build
docker compose logs -f
```

First run downloads ~2 GB (Whisper model + three Piper voices) into `./data`.
Later starts reuse them and come up in well under a minute:

```
[bootstrap] voice en_US-lessac-medium already present
[bootstrap] whisper model cached
[MULTI-REGISTRAR] Maya SUCCESS - Registered as ext 17512
```

Then start the host-side wrapper:

```bash
cd claude-api-server
# Default model is claude-sonnet-5. For OmniRoute / a custom API:
#   CLAUDE_MODEL=default            # let Claude Code pick
#   CLAUDE_MODEL=gemini-2.5-flash  # or whatever your proxy supports
node server.js
```

## How local speech works

| | Local (default) | Cloud (opt-in) |
|---|---|---|
| STT | faster-whisper in-container | OpenAI Whisper (`STT_MODE=cloud`) |
| TTS | Piper in-container | ElevenLabs (`TTS_MODE=cloud`) |
| Keys | none | API keys required |
| Data | never leaves the PC | sent to the provider |

Both sidecars listen on loopback inside the container (`9001` STT, `9002` TTS)
and are also published to `127.0.0.1` on the host so `claude-phone doctor` can
health-check them.

## Windows gotchas

**CRLF line endings.** If the container restart-loops with
`/usr/bin/env: 'bash\r': No such file or directory`, a Windows editor saved a
shell script with `\r\n`. The Dockerfile strips CR at build time and
`.gitattributes` forces LF, but if you hit it:

```bash
sed -i 's/\r$//' docker/entrypoint.sh docker/supervisord.conf
docker compose build
```

**Docker file sharing.** The `./data` bind mount needs the drive shared in
Docker Desktop → Settings → Resources → File Sharing, or models re-download
every start.

**`host.docker.internal`** is how the container reaches `claude-api-server` on
the host. It is Docker Desktop-specific; on native Linux Docker use the bridge
gateway or host networking instead.

## More

- [README.md](README.md) — quickstart
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — failure modes
- [docs/LANGUAGES.md](docs/LANGUAGES.md) — Hindi/Marathi
- [CLAUDE.md](CLAUDE.md) — architecture
