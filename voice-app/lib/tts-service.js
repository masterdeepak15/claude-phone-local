/**
 * Text-to-Speech Service
 *
 * Default mode ("local"): sends text to the local Piper sidecar container
 * (tts-local) and saves the returned WAV — no API key, fully offline.
 *
 * Optional mode ("cloud", set TTS_MODE=cloud): original ElevenLabs API
 * behavior, preserved for anyone who still wants it.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const TTS_MODE = (process.env.TTS_MODE || 'local').toLowerCase();
const TTS_LOCAL_URL = process.env.TTS_LOCAL_URL || 'http://tts-local:9002';
const PIPER_VOICE = process.env.PIPER_VOICE || 'en_US-lessac-medium';
// Base URL other containers (FreeSWITCH) use to fetch generated audio back
// from this voice-app container. Under Docker Desktop bridge networking
// this must be the service name, not 127.0.0.1.
const AUDIO_BASE_URL = process.env.AUDIO_BASE_URL || 'http://voice-app:3000';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = 'JAgnJveGGUh4qy4kh6dF';
const MODEL_ID = 'eleven_turbo_v2';

// Audio output directory (set via setAudioDir)
let audioDir = path.join(__dirname, '../audio-temp');

/**
 * Set the audio output directory
 * @param {string} dir - Absolute path to audio directory
 */
function setAudioDir(dir) {
  audioDir = dir;
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
    logger.info('Created audio directory', { path: audioDir });
  }
}

function generateFilename(text, ext) {
  const hash = crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
  const timestamp = Date.now();
  return `tts-${timestamp}-${hash}.${ext}`;
}

/**
 * Generate speech using the local Piper sidecar
 * @param {string} text
 * @param {string} voice - Piper voice name (falls back to PIPER_VOICE env)
 * @returns {Promise<string>} HTTP URL to the generated WAV file
 */
async function generateSpeechLocal(text, voice) {
  const startTime = Date.now();

  logger.info('Generating speech with local Piper', { textLength: text.length, voice });

  const response = await axios({
    method: 'POST',
    url: `${TTS_LOCAL_URL}/speak`,
    headers: { 'Content-Type': 'application/json' },
    data: { text, voice: voice || PIPER_VOICE },
    responseType: 'arraybuffer',
    timeout: 30000
  });

  const filename = generateFilename(text, 'wav');
  const filepath = path.join(audioDir, filename);
  fs.writeFileSync(filepath, response.data);

  const latency = Date.now() - startTime;
  logger.info('Speech generation successful (local)', {
    filename, fileSize: response.data.length, latency, textLength: text.length
  });

  return `${AUDIO_BASE_URL}/audio-files/${filename}`;
}

/**
 * Generate speech using ElevenLabs (cloud mode)
 */
async function generateSpeechCloud(text, voiceId = DEFAULT_VOICE_ID) {
  const startTime = Date.now();

  try {
    if (!ELEVENLABS_API_KEY) {
      throw new Error('ELEVENLABS_API_KEY environment variable not set');
    }

    logger.info('Generating speech with ElevenLabs', { textLength: text.length, voiceId, model: MODEL_ID });

    const response = await axios({
      method: 'POST',
      url: `${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY
      },
      data: {
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
      },
      responseType: 'arraybuffer'
    });

    const filename = generateFilename(text, 'mp3');
    const filepath = path.join(audioDir, filename);
    fs.writeFileSync(filepath, response.data);

    const latency = Date.now() - startTime;
    logger.info('Speech generation successful (cloud)', {
      filename, fileSize: response.data.length, latency, textLength: text.length
    });

    return `${AUDIO_BASE_URL}/audio-files/${filename}`;
  } catch (error) {
    const latency = Date.now() - startTime;
    logger.error('Speech generation failed', {
      error: error.message, latency, textLength: text?.length,
      responseStatus: error.response?.status, responseData: error.response?.data?.toString()
    });

    if (error.response?.status === 401) throw new Error('ElevenLabs API authentication failed - check API key');
    if (error.response?.status === 429) throw new Error('ElevenLabs API rate limit exceeded');
    if (error.response?.status === 400) throw new Error('Invalid request to ElevenLabs API');
    throw new Error(`TTS generation failed: ${error.message}`);
  }
}

/**
 * Convert text to speech (local Piper by default, ElevenLabs if TTS_MODE=cloud)
 * @param {string} text
 * @param {string} voiceId - Piper voice name (local) or ElevenLabs voice ID (cloud)
 * @returns {Promise<string>} HTTP URL to audio file
 */
async function generateSpeech(text, voiceId) {
  if (TTS_MODE === 'cloud') {
    return generateSpeechCloud(text, voiceId || DEFAULT_VOICE_ID);
  }
  return generateSpeechLocal(text, voiceId);
}

/**
 * Clean up old audio files (older than specified age)
 */
function cleanupOldFiles(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    const files = fs.readdirSync(audioDir);
    let deletedCount = 0;
    files.forEach(file => {
      if (!file.startsWith('tts-') || !(file.endsWith('.mp3') || file.endsWith('.wav'))) return;
      const filepath = path.join(audioDir, file);
      const stats = fs.statSync(filepath);
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filepath);
        deletedCount++;
      }
    });
    if (deletedCount > 0) logger.info('Cleaned up old audio files', { deletedCount });
  } catch (error) {
    logger.warn('Failed to cleanup old audio files', { error: error.message });
  }
}

/**
 * Get list of available voices
 * @returns {Promise<Array>} local: Piper voices installed; cloud: ElevenLabs voices
 */
async function getAvailableVoices() {
  if (TTS_MODE !== 'cloud') {
    const response = await axios.get(`${TTS_LOCAL_URL}/voices`, { timeout: 5000 });
    return response.data.voices || [];
  }

  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY environment variable not set');
  }
  const response = await axios({
    method: 'GET',
    url: `${ELEVENLABS_API_URL}/voices`,
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });
  return response.data.voices;
}

// Initialize audio directory
setAudioDir(audioDir);

// Periodic cleanup (every 30 minutes)
setInterval(() => cleanupOldFiles(), 30 * 60 * 1000);

module.exports = {
  generateSpeech,
  setAudioDir,
  cleanupOldFiles,
  getAvailableVoices,
  mode: TTS_MODE
};
