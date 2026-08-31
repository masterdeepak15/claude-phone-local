"""
Local text-to-speech sidecar for claude-phone.
Wraps Piper behind a tiny HTTP API so voice-app (Node) can call it the same
way it used to call ElevenLabs — except fully offline.

POST /speak   json: {"text": "...", "voice": "en_US-lessac-medium"}
              -> raw WAV bytes

GET  /voices  -> {"voices": ["en_US-lessac-medium", ...]}  (installed models)
GET  /health  -> {"status": "ok"}
"""

import glob
import os
import subprocess
import tempfile

from fastapi import FastAPI, Response
from pydantic import BaseModel

VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", "/voices")
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")

app = FastAPI(title="claude-phone local TTS")


class SpeakRequest(BaseModel):
    text: str
    voice: str | None = None


def voice_paths(voice: str):
    model = os.path.join(VOICES_DIR, f"{voice}.onnx")
    config = os.path.join(VOICES_DIR, f"{voice}.onnx.json")
    return model, config


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/voices")
def voices():
    names = sorted(
        os.path.splitext(os.path.basename(p))[0]
        for p in glob.glob(os.path.join(VOICES_DIR, "*.onnx"))
    )
    return {"voices": names}


@app.post("/speak")
def speak(req: SpeakRequest):
    voice = req.voice or DEFAULT_VOICE
    model, config = voice_paths(voice)

    if not os.path.exists(model):
        return Response(
            content=f"Voice model not found: {model}. Download it into {VOICES_DIR}/ "
                     f"(see README) and restart tts-local.".encode(),
            status_code=404,
            media_type="text/plain",
        )

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        out_path = tf.name

    try:
        subprocess.run(
            ["piper", "--model", model, "--config", config, "--output_file", out_path],
            input=req.text.encode("utf-8"),
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with open(out_path, "rb") as f:
            wav_bytes = f.read()
        return Response(content=wav_bytes, media_type="audio/wav")
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass
