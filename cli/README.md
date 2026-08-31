# Claude Phone CLI

> **Note:** since v2 all services run in a **single container**, so commands
> that used to target one service now act on the whole stack. Speech models and
> config live in `./data` and are provisioned automatically on first run --
> there are no manual download steps. See [../README.md](../README.md).

Command-line interface for Claude Phone. Single-command setup and management.

## Installation

### One-Line Install

```bash
npm install -g claude-phone-local
```

### Manual Install

```bash
git clone https://github.com/masterdeepak15/claude-phone-local.git
cd claude-phone/cli
npm install
npm link
```

## Setup Wizard

```bash
claude-phone setup
```

The wizard guides you through configuration based on your deployment type:

### Voice Server

Select this when setting up a Raspberry Pi or dedicated voice box that connects to a remote API server.

**What it asks for:**
1. 3CX SIP domain and registrar
2. API server IP and port (where claude-api-server runs)
3. Local or cloud speech (local = faster-whisper + Piper, no API keys; cloud = ElevenLabs + OpenAI)
4. Device configuration (name, extension, auth, voice, prompt)
5. Server LAN IP (for RTP audio routing)

**What `claude-phone start` does:**
- Starts the `claude-phone` container (drachtio, FreeSWITCH, voice-app, STT, TTS under supervisord)
- Connects to the remote API server you specified

### API Server

Select this when setting up the Claude API wrapper on a machine with Claude Code CLI.

**What it asks for:**
- API server port (default: 3333)

**What `claude-phone start` does:**
- Starts claude-api-server on the configured port

**Note:** You can also just run `claude-phone api-server` without setup - it defaults to port 3333.

### Both (All-in-One)

Select this for a single machine running everything.

**What it asks for:**
1. Local or cloud speech (local = faster-whisper + Piper, no API keys; cloud = ElevenLabs + OpenAI)
2. 3CX SIP domain and registrar
3. Device configuration
4. Server LAN IP, API port, and HTTP port

**What `claude-phone start` does:**
- Starts the `claude-phone` container (drachtio, FreeSWITCH, voice-app, STT, TTS under supervisord)
- Starts claude-api-server

### Pi Auto-Detection

On Raspberry Pi, the setup wizard:
- Recommends "Voice Server" mode if you select "Both"
- Checks for 3CX SBC on port 5060 and auto-configures drachtio to use 5070 to avoid conflicts
- Uses optimized settings for Pi hardware

## Commands

### Setup & Configuration

```bash
claude-phone setup              # Interactive configuration wizard
claude-phone setup --skip-prereqs   # Skip prerequisite checks
claude-phone config show        # Display config (secrets redacted)
claude-phone config path        # Show config file location (~/.claude-phone/config.json)
claude-phone config reset       # Reset config (creates backup first)
```

### Service Management

```bash
claude-phone start              # Start services based on installation type
claude-phone stop               # Stop all services
claude-phone status             # Show service status
claude-phone doctor             # Health check for dependencies and services
claude-phone api-server         # Start API server standalone (default port 3333)
claude-phone api-server -p 4000 # Start on custom port
```

### Device Management

```bash
claude-phone device add         # Add a new device/extension
claude-phone device list        # List configured devices
claude-phone device remove <name>   # Remove a device by name
```

### Logs

```bash
claude-phone logs               # Tail all service logs
claude-phone logs               # all services (one container now)
claude-phone logs drachtio      # SIP server only
claude-phone logs freeswitch    # Media server only
```

### Backup & Recovery

```bash
claude-phone backup             # Create timestamped backup
claude-phone restore            # Restore from backup (interactive)
```

### Maintenance

```bash
claude-phone update             # Update Claude Phone to latest
claude-phone uninstall          # Complete removal
```

## Configuration Files

All configuration is stored in `~/.claude-phone/`:

```
~/.claude-phone/
├── config.json           # Main configuration (chmod 600)
├── docker-compose.yml    # Generated: one service + ./data volume
├── .env                  # Generated environment file
├── server.pid            # API server process ID
└── backups/              # Configuration backups
```

### Config Structure

```json
{
  "version": "1.0.0",
  "installationType": "both",
  "api": {
    "elevenlabs": { "apiKey": "...", "defaultVoiceId": "...", "validated": true },
    "openai": { "apiKey": "...", "validated": true }
  },
  "sip": {
    "domain": "your-3cx.3cx.us",
    "registrar": "192.168.1.100",
    "transport": "udp"
  },
  "server": {
    "claudeApiPort": 3333,
    "httpPort": 3000,
    "externalIp": "192.168.1.50"
  },
  "devices": [{
    "name": "Morpheus",
    "extension": "9000",
    "authId": "9000",
    "password": "***",
    "voiceId": "elevenlabs-voice-id",
    "prompt": "You are Morpheus..."
  }],
  "deployment": {
    "mode": "both"
  }
}
```

## Split Deployment Example

### On Raspberry Pi (Voice Server)

```bash
# Install
npm install -g claude-phone-local

# Setup - select "Voice Server"
# Enter your Mac's IP when prompted for API server
claude-phone setup

# Start voice services
claude-phone start
```

### On Mac (API Server)

```bash
# Install (if not already)
npm install -g claude-phone-local

# Start API server (no setup needed)
claude-phone api-server

# Or on a custom port
claude-phone api-server --port 4000
```

## Requirements

- **Node.js 18+** - Required for CLI
- **Docker** - Required for Voice Server or Both modes
- **Claude Code CLI** - Required for API Server or Both modes

## Development

```bash
# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
