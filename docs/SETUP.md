# Setup Guide

End-to-end walkthrough for a single-PC install: 3CX extension, SBC, Docker,
npm install, `claude-phone setup`, `claude-phone start`. Written for the
"Both (all-in-one)" installation type — everything on one Windows/Mac/Linux
machine, which is what most people want. For Raspberry Pi split deployments
see [cli/README.md](../cli/README.md#split-deployment-example).

## Order of operations

1. Create a 3CX extension
2. Install the 3CX SBC on this PC (only if this PC isn't already inside your
   3CX network)
3. Install Docker Desktop
4. `npm install -g claude-phone-local`
5. `claude-phone setup`
6. `claude-phone start`

Do them in this order — `claude-phone setup` asks for the extension's
credentials, and detects whether a 3CX SBC is already running on this PC.

---

## 1. Create a 3CX extension

In the 3CX Admin Console:

1. **Users → Add User** (or reuse an existing one you don't mind dedicating
   to this).
2. Give it an extension number, e.g. `17512`.
3. Under the user's **SIP/VoIP Devices** or **Authentication** tab, note:
   - **Extension** (e.g. `17512`)
   - **Auth ID** — often different from the extension number
   - **Authentication password**
4. Note your **3CX domain** too (e.g. `yourcompany.3cx.us` or
   `1234.3cx.cloud`) — shown in the Admin Console URL or under **General
   Settings**.

You'll type all four of these into `claude-phone setup` later. Keep this tab
open.

**Security tip:** don't reuse an extension you actually answer calls on
personally — Claude answers this one with full shell access to the host
(see [Security](../README.md#security)). A dedicated extension with
restricted inbound routing is safer.

## 2. Install the 3CX SBC (only if needed)

Skip this step if this PC is already on the same LAN as your 3CX PBX with no
NAT/firewall between them — you can register directly against the PBX and
skip the SBC.

Install the SBC when this PC is remote from the PBX (e.g. cloud-hosted 3CX,
this PC on a different network) — the SBC is a local relay that keeps the
inbound SIP path this app cares about all on `127.0.0.1`/LAN, and it's what
lets you skip poking holes in your firewall for SIP directly to this PC.

1. In 3CX Admin Console: **Admin → SBC → Add SBC**, choose **Generic /
   Windows**, and follow the download link (or find the "3CX Session Border
   Controller" installer under downloads for your PBX).
2. Run the installer on this PC. It'll ask for a **provisioning link** — copy
   it from the Admin Console's SBC page.
3. Once installed, the SBC runs as a Windows service (`3CXSBC`) and binds SIP
   on port **5060**. `claude-phone setup` checks for this automatically later
   and, if found, tells drachtio (this app's SIP stack) to use port **5070**
   instead — so the two never fight over the same port.
4. The SBC config file lives at `C:\ProgramData\3CXSBC\3cxsbc.conf` and
   normally needs no manual editing — `LocalSipAddr=0.0.0.0` means it
   self-detects this PC's current LAN IP every time it starts, so it survives
   network changes (new office, DHCP renewal) without reconfiguration.

## 3. Install Docker Desktop

- Windows/Mac: [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  — enable the WSL2 backend on Windows during install.
- Linux: [Docker Engine](https://docs.docker.com/engine/install/) + the
  Compose plugin.

Verify it's running:

```bash
docker --version
docker compose version
```

You'll also need **Node.js 18+** and the **Claude Code CLI**, logged in
(`claude --version`).

## 4. Install claude-phone-local

```bash
npm install -g claude-phone-local
```

This installs the `claude-phone` CLI globally and automatically installs the
host-side dependencies for `claude-api-server` and `mcp-server` — no manual
`npm install` in subfolders needed.

Verify:

```bash
claude-phone --version
```

## 5. Run the setup wizard

```bash
claude-phone setup
```

It asks these questions, in this order (for "Both (all-in-one)" — the
default and most common choice):

### Installation type

> **What are you installing?**
> - Voice Server (Pi/Linux) — this machine only runs the phone/audio side,
>   talks to a remote API server (e.g. a Raspberry Pi calling out to your
>   main PC)
> - API Server — this machine only runs the Claude wrapper, no phone
>   hardware/Docker here
> - Both (all-in-one) — full stack on one machine ← most people want this,
>   and what the rest of this guide walks through

### Speech (STT/TTS) mode

> **How should speech-to-text and text-to-speech work?**
> - Local (offline, no API keys, no cost) — faster-whisper + Piper, run as
>   Docker containers, fully private
> - Cloud (ElevenLabs + OpenAI) — requires paid API keys, higher voice
>   quality, needs internet

Choosing **Local** then asks:
- **Piper voice** to use (default `en_US-lessac-medium`) — auto-downloaded
- **faster-whisper model size** (`tiny`/`base`/`small`/`medium`) — bigger is
  more accurate but slower; `medium` is recommended for Hindi/Marathi

Choosing **Cloud** asks for an **ElevenLabs API key** (validated live) and a
default **ElevenLabs voice ID**, then an **OpenAI API key** for Whisper STT.

### SIP / 3CX configuration

Setup first checks port 5060 and the SBC process on its own — if it finds one
running, the next question defaults to "yes" automatically.

> **Is the 3CX SBC service running on this same PC?**

Answer **yes** if you installed the SBC in step 2. This makes drachtio use
port 5070 automatically (avoiding the SBC's port 5060) and makes the
registrar address self-track this PC's current LAN IP on every
`claude-phone start` — so it survives network changes without re-running
setup.

Answer **no** if you're registering directly against a remote/cloud 3CX PBX,
or another SIP provider entirely — you'll then be asked for the registrar IP
directly.

> **3CX domain** (e.g. `your-3cx.3cx.us`)

The tenant hostname from step 1.

> **3CX registrar IP** (only if you answered "no" above)

The IP/hostname SIP REGISTER requests actually go to.

### Device configuration

This is the extension Claude answers on — the one from step 1.

> **Device name** (e.g. `Maya`)
> **SIP extension number** (e.g. `17512`)
> **SIP auth ID**
> **SIP password**
> **System prompt** — her personality/instructions, e.g. "You are a helpful
> AI assistant. Keep voice responses under 40 words."

If you chose **Local** speech mode: **Piper voice for this device** (falls
back to the default voice you picked earlier). If you chose **Cloud**:
**ElevenLabs voice ID** (validated live).

### Server configuration

> **Auto-detect the LAN IP on every "claude-phone start"?**

**Recommended: yes.** This is the IP that goes into RTP/SDP so the SBC/PBX
knows where to send call audio. Auto mode re-detects this PC's current LAN
IP every time you run `claude-phone start`, so moving between networks
(home, office, a different Wi-Fi) doesn't require re-running setup. Answering
no locks in whatever IP is current right now — you'll need to re-run
`claude-phone setup` if it ever changes.

> **Claude API server port** (default `3333`)
> **Voice app HTTP port** (default `3000`)

Both are safe to leave at their defaults unless something else on this PC
already uses them.

### MCP server (lets Claude call you)

> **Number/extension for Claude to call YOU on**

This must be a **different** number from the device extension above — 3CX
rejects a device calling itself. If you only have the one extension from
step 1, you'll need a second number here (your mobile, a second 3CX
extension, or a DID) for the "call me when it's done" feature to work. See
[Claude calling you](../README.md#claude-calling-you).

Setup then registers the MCP server with your Claude Code CLI automatically.

---

## 6. Start it

```bash
claude-phone start
```

This:
1. Runs prerequisite checks (Node, Docker, disk space, network)
2. Builds/starts the Docker container (drachtio, FreeSWITCH, voice-app, STT,
   TTS) — first run downloads ~2GB of speech models, cached in `./data` (well,
   `~/.claude-phone/data`) for every future start
3. Waits for the voice stack to actually be ready to accept calls (not just
   for the container to be up)
4. Starts `claude-api-server` on the host and verifies it's actually healthy

When you see `✓ All services running!` with your extension listed under
"Ready to receive calls on", call it.

## Check it worked

```bash
claude-phone status
claude-phone doctor           # deeper health check
claude-phone logs api-server  # host-side Claude wrapper log
docker logs claude-phone -f   # container-side SIP/voice log
```

If registration succeeded you'll see a line like:

```
[MULTI-REGISTRAR] Maya SUCCESS - Registered as ext 17512
```

Full failure-mode reference: [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
