#!/usr/bin/env bash
# Bootstraps persistent state in /data, then hands off to supervisord.
# Everything here is idempotent: it only fetches what is missing, so a restart
# with a populated ./data volume starts instantly and never re-downloads.
set -euo pipefail

log() { echo "[bootstrap] $*"; }

: "${EXTERNAL_IP:?must be set to this host LAN IP}"
export DRACHTIO_SECRET="${DRACHTIO_SECRET:-cymru}"
export RTP_START="${RTP_START:-30000}"
export RTP_END="${RTP_END:-30100}"
# FreeSWITCH binds sofia to the container IP (mrf.xml sip-ip = $${local_ip_v4}),
# never to loopback. drachtio lives in this same network namespace, so it must
# be pointed at that same address - advertising 127.0.0.1 would send it to a
# port nothing is listening on. RTP still advertises EXTERNAL_IP for the SBC.
FS_SIP_IP="$(hostname -i | awk '{print $1}')"
export FS_SIP_IP
log "FreeSWITCH SIP will advertise ${FS_SIP_IP}; RTP will advertise ${EXTERNAL_IP}"

export PIPER_VOICES_DIR=/data/voices
export HF_HOME=/data/models/huggingface

mkdir -p /data/voices /data/models/huggingface /data/audio /data/config

# --- Piper voices -----------------------------------------------------------
# VOICES is a space-separated list of Piper voice names. Each is resolved to its
# path in the rhasspy/piper-voices repo from the language prefix.
PIPER_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
VOICES="${PIPER_VOICES:-en_US-lessac-medium hi_IN-priyamvada-medium mr_IN-google-medium}"

voice_repo_path() {
  # en_US-lessac-medium -> en/en_US/lessac/medium/en_US-lessac-medium
  local name="$1"
  local locale="${name%%-*}"            # en_US
  local rest="${name#*-}"               # lessac-medium
  local speaker="${rest%%-*}"           # lessac
  local quality="${rest##*-}"           # medium
  local lang="${locale%%_*}"            # en
  echo "${lang}/${locale}/${speaker}/${quality}/${name}"
}

for v in $VOICES; do
  if [ -f "/data/voices/${v}.onnx" ]; then
    log "voice ${v} already present"
    continue
  fi
  path="$(voice_repo_path "$v")"
  log "downloading voice ${v} ..."
  if curl -fsSL --retry 3 --retry-delay 2 "${PIPER_BASE}/${path}.onnx" -o "/data/voices/${v}.onnx.part" \
     && curl -fsSL --retry 3 --retry-delay 2 "${PIPER_BASE}/${path}.onnx.json" -o "/data/voices/${v}.onnx.json"; then
    mv "/data/voices/${v}.onnx.part" "/data/voices/${v}.onnx"
    log "voice ${v} ready"
  else
    rm -f "/data/voices/${v}.onnx.part"
    log "WARNING: could not download voice ${v} - it will be unavailable"
  fi
done

# --- Whisper model ----------------------------------------------------------
# faster-whisper pulls the model on first use into HF_HOME, which lives on the
# /data volume, so it survives restarts. Pre-fetch it so the first call is fast.
if [ "${PREFETCH_WHISPER:-1}" = "1" ]; then
  log "ensuring Whisper model '${WHISPER_MODEL:-medium}' is cached (first run may take a while) ..."
  /opt/venv/bin/python - <<'PY' || log "WARNING: Whisper prefetch failed; it will download on first call"
import os
from faster_whisper import WhisperModel
WhisperModel(
    os.environ.get("WHISPER_MODEL", "medium"),
    device=os.environ.get("WHISPER_DEVICE", "cpu"),
    compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
)
print("[bootstrap] whisper model cached")
PY
fi

# --- Device config ----------------------------------------------------------
# Seed /data/config/devices.json once, then never touch it again - it holds the
# user's SIP credentials and is theirs to edit.
if [ ! -f /data/config/devices.json ]; then
  if [ -n "${SIP_EXTENSION:-}" ]; then
    log "generating devices.json for extension ${SIP_EXTENSION}"
    /usr/bin/node -e '
      const fs = require("fs");
      const ext = process.env.SIP_EXTENSION;
      fs.writeFileSync("/data/config/devices.json", JSON.stringify({
        [ext]: {
          name: process.env.DEVICE_NAME || "Maya",
          extension: ext,
          authId: process.env.SIP_AUTH_ID || ext,
          password: process.env.SIP_PASSWORD || "",
          voice: process.env.PIPER_VOICE || "en_US-lessac-medium",
          language: process.env.STT_LANGUAGE || "auto",
          prompt: process.env.DEVICE_PROMPT ||
            "You are " + (process.env.DEVICE_NAME || "Maya") +
            ", a helpful AI assistant speaking to the user over the phone. " +
            "ALWAYS reply in the same language the user just used, using that " +
            "language native script. Keep voice responses under 40 words."
        }
      }, null, 2) + "\n");
    '
  else
    log "SIP_EXTENSION not set - skipping devices.json generation"
  fi
else
  log "devices.json already present (left untouched)"
fi

log "bootstrap complete - starting services"
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
