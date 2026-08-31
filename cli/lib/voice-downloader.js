import fs from 'fs';
import path from 'path';
import https from 'https';

// Curated list of common Piper voices with their known-good download URLs.
// If a user picks one of these during setup, we fetch it automatically.
// Anyone who wants a different voice from the full catalog at
// huggingface.co/rhasspy/piper-voices can still drop files into
// <ttsLocal>/voices/ manually — that path stays supported.
const KNOWN_VOICES = {
  'en_US-lessac-medium': 'en/en_US/lessac/medium',
  'en_US-amy-medium': 'en/en_US/amy/medium',
  'en_US-ryan-high': 'en/en_US/ryan/high',
  'en_GB-alan-medium': 'en/en_GB/alan/medium'
};

const BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // follow redirect
        https.get(response.headers.location, (redirected) => {
          redirected.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Ensure a Piper voice model is present locally, downloading it if it's a
 * known voice and not already there. Silently does nothing for unknown
 * voice names (those are assumed to be manually placed by the user).
 * @param {string} voiceName - e.g. "en_US-lessac-medium"
 * @param {string} voicesDir - path to tts-local/voices
 * @returns {Promise<{downloaded: boolean, skipped: boolean, error?: string}>}
 */
export async function ensureVoiceModel(voiceName, voicesDir) {
  const modelPath = path.join(voicesDir, `${voiceName}.onnx`);
  const configPath = path.join(voicesDir, `${voiceName}.onnx.json`);

  if (fs.existsSync(modelPath) && fs.existsSync(configPath)) {
    return { downloaded: false, skipped: true };
  }

  const subPath = KNOWN_VOICES[voiceName];
  if (!subPath) {
    return {
      downloaded: false,
      skipped: false,
      error: `Unknown voice "${voiceName}" — not in the auto-download list. ` +
             `Download it manually from huggingface.co/rhasspy/piper-voices ` +
             `into ${voicesDir}/`
    };
  }

  fs.mkdirSync(voicesDir, { recursive: true });

  await downloadFile(`${BASE_URL}/${subPath}/${voiceName}.onnx`, modelPath);
  await downloadFile(`${BASE_URL}/${subPath}/${voiceName}.onnx.json`, configPath);

  return { downloaded: true, skipped: false };
}

export { KNOWN_VOICES };
