/**
 * Speech-to-Text Client
 *
 * Default mode ("local"): sends audio to the local faster-whisper sidecar
 * container (stt-local) — no API key, fully offline.
 *
 * Optional mode ("cloud", set STT_MODE=cloud): original OpenAI Whisper API
 * behavior, preserved for anyone who still wants it.
 */

const WaveFile = require("wavefile").WaveFile;
const axios = require("axios");
const FormData = require("form-data");

const STT_MODE = (process.env.STT_MODE || "local").toLowerCase();
// Docker Desktop bridge networking: reach the sidecar by service name.
const STT_LOCAL_URL = process.env.STT_LOCAL_URL || "http://stt-local:9001";

// Lazy-initialized OpenAI client (cloud mode only)
let openai = null;

function getOpenAIClient() {
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[WHISPER] OPENAI_API_KEY not set - cloud STT will not work");
      return null;
    }
    const OpenAI = require("openai");
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * Convert L16 PCM buffer to WAV format
 * @param {Buffer} pcmBuffer - Raw L16 PCM audio data
 * @param {number} sampleRate - Sample rate (default: 8000 Hz for telephony)
 * @returns {Buffer} WAV file buffer
 */
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  const wav = new WaveFile();
  const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
  wav.fromScratch(1, sampleRate, "16", samples);
  return Buffer.from(wav.toBuffer());
}

async function transcribeLocal(wavBuffer, language) {
  const form = new FormData();
  form.append("file", wavBuffer, { filename: "audio.wav", contentType: "audio/wav" });
  form.append("language", language);

  const timestamp = new Date().toISOString();
  const response = await axios.post(`${STT_LOCAL_URL}/transcribe`, form, {
    headers: form.getHeaders(),
    timeout: 30000
  });

  const text = (response.data && response.data.text) ? response.data.text.trim() : "";
  console.log(`[${timestamp}] WHISPER-LOCAL Transcribed: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);
  return text;
}

async function transcribeCloud(wavBuffer, language) {
  const fs = require("fs");
  const path = require("path");
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("OpenAI API key not configured");
  }

  const tempFile = path.join("/tmp", "whisper-" + Date.now() + ".wav");
  fs.writeFileSync(tempFile, wavBuffer);

  try {
    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempFile),
      model: "whisper-1",
      language,
      response_format: "text"
    });

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] WHISPER-CLOUD Transcribed: ${transcription.substring(0, 100)}${transcription.length > 100 ? "..." : ""}`);
    return transcription;
  } finally {
    try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
  }
}

/**
 * Transcribe audio (local by default, cloud if STT_MODE=cloud)
 * @param {Buffer} audioBuffer - Audio data (either WAV or raw PCM)
 * @param {Object} options - { format: "wav"|"pcm", sampleRate, language }
 * @returns {Promise<string>} Transcribed text
 */
async function transcribe(audioBuffer, options = {}) {
  const { format = "pcm", sampleRate = 8000, language = "en" } = options;

  const wavBuffer = format === "pcm" ? pcmToWav(audioBuffer, sampleRate) : audioBuffer;

  if (STT_MODE === "cloud") {
    return transcribeCloud(wavBuffer, language);
  }
  return transcribeLocal(wavBuffer, language);
}

/**
 * Check if STT is configured and available
 * @returns {boolean}
 */
function isAvailable() {
  if (STT_MODE === "cloud") {
    return !!process.env.OPENAI_API_KEY;
  }
  return true; // local mode has no key requirement
}

module.exports = {
  transcribe,
  pcmToWav,
  isAvailable,
  mode: STT_MODE
};
