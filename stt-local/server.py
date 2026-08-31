"""
Local speech-to-text sidecar for claude-phone.
Wraps faster-whisper behind a tiny HTTP API so voice-app (Node) can call it
the same way it used to call OpenAI's Whisper API — except fully offline.

POST /transcribe   multipart form: file=<wav bytes>, language=en|hi|mr|auto
                    -> {"text": "...", "language": "hi"}
                    language=auto (or empty) lets Whisper detect it and the
                    detected code comes back so the caller can pick a matching
                    TTS voice.
GET  /health        -> {"status": "ok", "model": "small"}
"""

import io
import os

from fastapi import FastAPI, UploadFile, Form
from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

app = FastAPI(title="claude-phone local STT")

print(f"[stt-local] loading faster-whisper '{MODEL_SIZE}' ({DEVICE}/{COMPUTE_TYPE})...")
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
print("[stt-local] model ready")


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE}


@app.post("/transcribe")
async def transcribe(file: UploadFile, language: str = Form("en")):
    audio_bytes = await file.read()
    # "auto"/"" -> None makes faster-whisper detect the language itself.
    lang = None if language in ("auto", "", None) else language
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes), language=lang, vad_filter=True
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {"text": text, "language": info.language}
