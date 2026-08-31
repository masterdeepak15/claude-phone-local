# Claude Phone Local

Call a phone number (via 3CX) and talk to your local Claude Code CLI —
entirely offline for speech: local **faster-whisper** for speech-to-text,
local **Piper** for text-to-speech. No OpenAI or ElevenLabs API keys.

## Features

| Feature | Status |
|---|---|
| Inbound calls (call extension, talk to Claude) | ✅ |
| Outbound calls (Claude calls you) | ✅ (`voice-app/lib/outbound-*.js`) |
| Split deployment (Pi voice-server + main-PC API-server) | ✅ |
| Full `claude-phone` CLI (setup/start/stop/status/doctor/logs/backup/restore/update/uninstall) | ✅ |
| Multi-device / multi-extension personalities | ✅, voice field takes a Piper voice name in local mode |
| `/api/outbound-call`, `/api/query`, `/api/devices`, `/ask-structured` (n8n) | ✅ |
| Claude Code Skill (`docs/CLAUDE-CODE-SKILL.md`) | ✅ |
| Text-to-speech | local **Piper** by default, no API key (opt-in `TTS_MODE=cloud` for ElevenLabs) |
| Speech-to-text | local **faster-whisper** by default, no API key (opt-in `STT_MODE=cloud` for OpenAI) |

## How local speech works

- `voice-app/lib/whisper-client.js` calls a local `stt-local` sidecar
  (faster-whisper) by default instead of a cloud API.
- `voice-app/lib/tts-service.js` calls a local `tts-local` sidecar (Piper)
  by default instead of a cloud API.
- Both sidecars are plain FastAPI services (`stt-local/`, `tts-local/`),
  built and run by `docker-compose.yml` alongside `drachtio`, `freeswitch`,
  and `voice-app`.
- `cli/lib/commands/setup.js` asks "local or cloud" up front; local mode
  skips the ElevenLabs/OpenAI key prompts entirely and auto-downloads the
  chosen Piper voice.
- `cli/lib/commands/doctor.js` health-checks the local sidecars instead of
  cloud APIs when in local mode.

`sip-handler.js`, `conversation-loop.js`, `audio-fork.js`, `registrar.js`,
`multi-registrar.js`, `outbound-handler.js`, `outbound-session.js`,
`outbound-routes.js`, `query-routes.js`, `device-registry.js`,
`http-server.js`, and `claude-api-server/` all just talk to
`whisperClient`/`ttsService` through the functions above, so local vs.
cloud speech is invisible to them.

## Setup — Windows PC with Docker Desktop + WSL2, all-in-one

This is the setup this project is configured for by default.
`docker-compose.yml` already uses a normal Docker Desktop bridge network
with explicit published ports instead of `network_mode: host` (which Docker
Desktop can't do on Windows) — you don't need to touch WSL2's own Docker
engine at all.

### 1. Find your PC's LAN IP

Open PowerShell:
```powershell
ipconfig
```
Note the **IPv4 Address** of your active adapter (Wi-Fi or Ethernet) —
something like `192.168.1.50`. This is your `EXTERNAL_IP` — it's the address
3CX needs to send SIP/RTP traffic to.

### 2. Get the project into WSL2

Open your WSL2 Ubuntu terminal (Docker Desktop → Settings → Resources → WSL
Integration → make sure it's enabled for your distro):

```bash
cd ~
# copy/extract this project here, e.g.:
unzip /mnt/c/Users/<you>/Downloads/claude-phone-local-full.zip -d ~/
cd ~/claude-phone-local-full
cp .env.example .env
```
Edit `.env` and set `EXTERNAL_IP` to the IP from step 1.

Working from inside the WSL2 filesystem (`~/...`, not `/mnt/c/...`) is
important for Docker build speed and file-watching reliability.

### 3. Install the CLI and run setup

```bash
npm install -g ./cli
claude-phone setup
```
Wizard choices:
- Installation type → **Both** (single machine)
- STT/TTS → **Local (offline, no API keys)**
- 3CX domain / registrar → your 3CX FQDN
- Extension number/password → the extension you created in 3CX admin console

### 4. Get a Piper voice

```bash
mkdir -p tts-local/voices
curl -L -o tts-local/voices/en_US-lessac-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -o tts-local/voices/en_US-lessac-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

### 5. Windows Firewall

Allow inbound on the ports 3CX needs to reach, from PowerShell **as
Administrator**:
```powershell
New-NetFirewallRule -DisplayName "ClaudePhone SIP" -Direction Inbound -Protocol UDP -LocalPort 5060 -Action Allow
New-NetFirewallRule -DisplayName "ClaudePhone SIP-TCP" -Direction Inbound -Protocol TCP -LocalPort 5060 -Action Allow
New-NetFirewallRule -DisplayName "ClaudePhone RTP" -Direction Inbound -Protocol UDP -LocalPort 30000-30100 -Action Allow
```

### 6. Start it

```bash
claude-phone start
claude-phone doctor     # confirms Docker, drachtio, freeswitch, local STT, local TTS all green
claude-phone logs       # watch for "READY Voice interface is fully connected!"
```

### 7. Point 3CX at it

In the 3CX admin console, on the extension: set the extension's registration
target/NAT to your PC's LAN IP from step 1, and make sure its allowed media
port range matches `30000-30100`. Call the extension — it should answer and
you'll be talking to your local Claude Code CLI, fully offline for
speech-to-text and text-to-speech.

### Download a Piper voice (one-time)

```bash
mkdir -p tts-local/voices
curl -L -o tts-local/voices/en_US-lessac-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -L -o tts-local/voices/en_US-lessac-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

Want a different voice? Browse
[huggingface.co/rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)
and drop the matching `.onnx` + `.onnx.json` pair in `tts-local/voices/`,
then reference that name as the device's "voice" in `claude-phone device add`.

### faster-whisper model

Downloads automatically on first `stt-local` container start (cached in the
`stt-model-cache` Docker volume, so it only happens once). Pick the size
during `claude-phone setup` — `tiny`/`base` are fastest, `small`/`medium`
are more accurate but slower on CPU.

### 3CX + Claude Code CLI

Create your extension in the 3CX admin console, and make sure `claude`
(Claude Code CLI) is already logged in on whichever machine runs
`claude-api-server`.

## More docs

Full CLI reference, troubleshooting guide, and outbound API reference:
`README.md`, `docs/TROUBLESHOOTING.md`, `voice-app/README-OUTBOUND.md`, and
`docs/CLAUDE-CODE-SKILL.md`.
