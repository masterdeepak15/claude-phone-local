/**
 * SIP Call Handler with Conversation Loop
 * v12: Device registry integration with proper method names
 */

const { setTimeout: sleep } = require('node:timers/promises');

// FreeSWITCH (a separate container) fetches/connects to these - must be the
// voice-app container's address, not FreeSWITCH's own loopback.
const AUDIO_BASE_URL = process.env.AUDIO_BASE_URL || 'http://voice-app:3000';
const AUDIO_WS_HOST = new URL(AUDIO_BASE_URL).hostname;

// Audio cue URLs
const READY_BEEP_URL = `${AUDIO_BASE_URL}/static/ready-beep.wav`;
const GOTIT_BEEP_URL = `${AUDIO_BASE_URL}/static/gotit-beep.wav`;
const HOLD_MUSIC_URL = `${AUDIO_BASE_URL}/static/hold-music.wav`;

// Default voice ID (Morpheus)
const DEFAULT_VOICE_ID = 'JAgnJveGGUh4qy4kh6dF';

// Whisper language code -> Piper voice installed in tts-local/voices/.
// Whisper detects the caller's language per utterance and we answer in the
// same one. Override/extend with LANG_VOICE_MAP in .env as JSON.
const DEFAULT_LANG_VOICES = {
  en: 'en_US-lessac-medium',
  hi: 'hi_IN-priyamvada-medium',
  mr: 'mr_IN-google-medium'
};

let LANG_VOICES = DEFAULT_LANG_VOICES;
if (process.env.LANG_VOICE_MAP) {
  try {
    LANG_VOICES = Object.assign({}, DEFAULT_LANG_VOICES, JSON.parse(process.env.LANG_VOICE_MAP));
  } catch (e) {
    console.log('[' + new Date().toISOString() + '] LANG: bad LANG_VOICE_MAP JSON, using defaults');
  }
}

// Languages we will actually answer in. Anything Whisper detects outside this
// set falls back to the device's own voice, so a misdetection can't leave us
// with no installed model.
const SUPPORTED_LANGS = (process.env.SUPPORTED_LANGS || 'en,hi,mr')
  .split(',').map(function (x) { return x.trim(); }).filter(Boolean);

function voiceForLanguage(lang, fallbackVoice) {
  if (!lang) return fallbackVoice;
  if (SUPPORTED_LANGS.indexOf(lang) === -1) return fallbackVoice;
  return LANG_VOICES[lang] || fallbackVoice;
}

// Claude Code-style thinking phrases
const THINKING_PHRASES = [
  "Let me check that for you.",
  "One moment.",
  "Just a second.",
  "Looking into it now.",
  "Give me a moment.",
  "Checking on that.",
  "Hang on, almost there.",
  "Still working on it.",
  "Nearly done.",
  "Bear with me a moment.",
];

// Said only while the caller is already waiting, so they never hear the same
// line twice in a row within one wait.
const WAITING_PHRASES = [
  "Still working on this.",
  "Almost there.",
  "Just a little longer.",
  "Nearly finished.",
  "Hang in there, still going.",
  "Won't be much longer.",
];

function getRandomThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

function getRandomWaitingPhrase() {
  return WAITING_PHRASES[Math.floor(Math.random() * WAITING_PHRASES.length)];
}

function extractCallerId(req) {
  var from = req.get("From") || "";
  var match = from.match(/sip:([+\d]+)@/);
  if (match) return match[1];
  var numMatch = from.match(/<sip:(\d+)@/);
  if (numMatch) return numMatch[1];
  return "unknown";
}

/**
 * Extract dialed extension from SIP To header
 */
function extractDialedExtension(req) {
  var to = req.get("To") || "";
  var match = to.match(/sip:(\d+)@/);
  if (match) {
    return match[1];
  }
  return null;
}

function isGoodbye(transcript) {
  const lower = transcript.toLowerCase().trim();
  const goodbyePhrases = [
    // English
    'goodbye', 'good bye', 'bye', 'bye bye', 'hang up', 'end call', 'end the call',
    'close the call', 'cut the call', 'disconnect', "that's all", 'thats all',
    'thank you bye', 'talk later',
    // Hindi / Marathi (Devanagari + common romanisations)
    'अलविदा', 'नमस्ते', 'बाय', 'फोन बंद करो', 'कॉल बंद करो', 'बंद करो',
    'ठेवतो', 'ठेवते', 'फोन ठेव', 'बंद कर',
    'alvida', 'phone band karo', 'call band karo', 'band karo', 'thevto'
  ];
  return goodbyePhrases.some(function(phrase) {
    return lower === phrase || lower.includes(' ' + phrase) ||
           lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase);
  });
}

/**
 * Extract voice-friendly line from Claude's response
 * Priority: VOICE_RESPONSE > CUSTOM COMPLETED > COMPLETED > first sentence
 */
function extractVoiceLine(response) {
  // Priority 1: VOICE_RESPONSE (new format). Stops at the next labeled line
  // (COMPLETED, or another 🗣️/🎯 marker) rather than the first newline, so a
  // longer answer that wraps onto multiple lines isn't truncated. The word cap
  // is a sanity ceiling against a runaway response, not a target length - real
  // answers that need more room than a one-liner are expected and fine.
  var voiceMatch = response.match(/🗣️\s*VOICE_RESPONSE:\s*([\s\S]+?)(?=\n\s*🎯|\n\s*🗣️|$)/im);
  if (voiceMatch) {
    var text = voiceMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 200) {
      return text;
    }
  }

  // Priority 2: CUSTOM COMPLETED
  var customMatch = response.match(/🗣️\s*CUSTOM\s+COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (customMatch) {
    text = customMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
    if (text && text.split(/\s+/).length <= 50) {
      return text;
    }
  }

  // Priority 3: COMPLETED
  var completedMatch = response.match(/🎯\s*COMPLETED:\s*(.+?)(?:\n|$)/im);
  if (completedMatch) {
    return completedMatch[1].trim().replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
  }

  // Priority 4: First sentence
  var firstSentence = response.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length < 500) {
    return firstSentence.trim();
  }

  return response.substring(0, 500).trim();
}

/**
 * Play a clip the caller is allowed to interrupt.
 *
 * FreeSWITCH plays to completion unless told otherwise, so to support barge-in
 * we arm the detector, then issue uuid_break the moment the caller starts
 * talking. AudioForkSession turns capture on itself right when barge-in
 * fires (see audio-fork.js), so the words that triggered the interruption are
 * already becoming a real utterance - previously they were discarded (capture
 * stayed off during playback) and the caller had to repeat themselves after a
 * fresh ready-beep on the next turn.
 *
 * Returns the captured utterance if the caller interrupted (so the turn loop
 * can use it as their next input directly, no beep/re-prompt needed), or
 * `null` if playback completed without interruption.
 */
async function playInterruptible(endpoint, session, url) {
  if (!session) {
    await endpoint.play(url);
    return null;
  }

  let barged = false;
  const onBarge = function () {
    barged = true;
    // uuid_break stops the current playback on this leg immediately.
    endpoint.api('uuid_break', endpoint.uuid).catch(function () {});
  };

  session.once('barge-in', onBarge);
  session.setBargeInEnabled(true);
  try {
    await endpoint.play(url);
  } finally {
    session.setBargeInEnabled(false);
    session.removeListener('barge-in', onBarge);
  }

  if (!barged) return null;

  console.log('[' + new Date().toISOString() + '] BARGE-IN: caller interrupted, capturing what they said');
  try {
    // Capture already started the moment barge-in fired; this just waits for
    // the utterance to finish (end-of-speech silence) rather than starting a
    // fresh listen window that would miss the words already spoken.
    const utterance = await session.waitForUtterance({ timeoutMs: 15000 });
    // finalizeUtterance() resets utterance state but not captureEnabled -
    // turn it off now, otherwise every chunk while we transcribe/query
    // Claude keeps accumulating into a new stray utterance.
    session.setCaptureEnabled(false);
    return utterance;
  } catch (err) {
    console.log('[' + new Date().toISOString() + '] BARGE-IN: capture failed (' + err.message + '), falling back to a fresh listen');
    session.setCaptureEnabled(false);
    return null;
  }
}

/**
 * Main conversation loop
 * @param {Object} deviceConfig - Device configuration (name, prompt, voiceId, etc.) or null for default
 */
async function conversationLoop(endpoint, dialog, callUuid, options, deviceConfig) {
  const { ttsService, whisperClient, claudeBridge, wsPort, audioForkServer } = options;

  let session = null;
  let forkRunning = false;

  // Get device-specific settings
  const deviceName = deviceConfig ? deviceConfig.name : 'Morpheus';
  const devicePrompt = deviceConfig ? deviceConfig.prompt : null;
  // Local mode: device.voice is a Piper voice name (null falls back to PIPER_VOICE env).
  // Cloud mode: device.voiceId is an ElevenLabs voice ID (falls back to DEFAULT_VOICE_ID).
  const voiceId = ttsService.mode === 'cloud'
    ? ((deviceConfig && deviceConfig.voiceId) ? deviceConfig.voiceId : DEFAULT_VOICE_ID)
    : ((deviceConfig && deviceConfig.voice) ? deviceConfig.voice : null);
  // Voice used for the current turn - starts as the device voice and follows
  // the caller's detected language from the first utterance onward.
  let turnVoice = ttsService.mode === 'cloud'
    ? (deviceConfig && deviceConfig.voiceId ? deviceConfig.voiceId : DEFAULT_VOICE_ID)
    : (deviceConfig && deviceConfig.voice ? deviceConfig.voice : null);

  const greeting = deviceConfig && deviceConfig.name !== 'Morpheus'
    ? "Hello! I'm " + deviceConfig.name + ". How can I help you today?"
    : "Hello! I'm your server. How can I help you today?";

  try {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Starting (session: ' + callUuid + ', device: ' + deviceName + ', voice: ' + voiceId + ')...');

    // Play device-specific greeting with device voice BEFORE starting audio fork
    console.log('[' + new Date().toISOString() + '] Generating greeting...');
    const greetingUrl = await ttsService.generateSpeech(greeting, voiceId);
    console.log('[' + new Date().toISOString() + '] Playing greeting: ' + greetingUrl);
    await endpoint.play(greetingUrl);
    console.log('[' + new Date().toISOString() + '] Greeting played successfully');

    // Start fork for entire call AFTER greeting
    const wsUrl = 'ws://' + AUDIO_WS_HOST + ':' + wsPort + '/' + encodeURIComponent(callUuid);
    const sessionPromise = audioForkServer.expectSession(callUuid, { timeoutMs: 10000 });

    await endpoint.forkAudioStart({
      wsUrl: wsUrl,
      mixType: 'mono',
      sampling: '16k'
    });
    forkRunning = true;

    session = await sessionPromise;
    console.log('[' + new Date().toISOString() + '] AUDIO Fork connected');

    // Pre-render the goodbye clip in the background so hanging up doesn't
    // wait on a fresh Piper round-trip right when the caller wants off the
    // line. Regenerated per detected language below since turnVoice can change.
    let goodbyeUrlPromise = ttsService.generateSpeech("Goodbye! Call again anytime.", turnVoice);

    // Main conversation loop
    let turnCount = 0;
    const MAX_TURNS = 20;
    // Speech captured by a barge-in during the previous turn's playback -
    // consumed as this turn's input directly instead of a fresh ready-beep
    // and listen window, which would otherwise make the caller repeat
    // themselves after every interruption.
    let pendingUtterance = null;

    while (turnCount < MAX_TURNS) {
      turnCount++;
      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + '/' + MAX_TURNS);

      let utterance = null;

      if (pendingUtterance) {
        console.log('[' + new Date().toISOString() + '] LISTEN Using speech captured during barge-in: ' + pendingUtterance.audio.length + ' bytes');
        utterance = pendingUtterance;
        pendingUtterance = null;
      } else {
        // READY BEEP
        try {
          await endpoint.play(READY_BEEP_URL);
        } catch (e) {
          console.log('[' + new Date().toISOString() + '] BEEP: Ready beep failed, continuing');
        }

        session.setCaptureEnabled(true);
        console.log('[' + new Date().toISOString() + '] LISTEN Waiting for speech...');

        try {
          utterance = await session.waitForUtterance({ timeoutMs: 30000 });
          console.log('[' + new Date().toISOString() + '] LISTEN Got: ' + utterance.audio.length + ' bytes');
        } catch (err) {
          console.log('[' + new Date().toISOString() + '] LISTEN Timeout: ' + err.message);
        }

        session.setCaptureEnabled(false);
      }

      if (!utterance) {
        const promptUrl = await ttsService.generateSpeech("I didn't hear anything. Are you still there?", turnVoice);
        await endpoint.play(promptUrl);
        continue;
      }

      // GOT-IT BEEP
      try {
        await endpoint.play(GOTIT_BEEP_URL);
      } catch (e) {
        console.log('[' + new Date().toISOString() + '] BEEP: Got-it beep failed, continuing');
      }

      // Transcribe (language auto-detected unless STT_LANGUAGE pins one)
      const sttResult = await whisperClient.transcribeDetailed(utterance.audio, {
        format: 'pcm',
        sampleRate: 16000,
        language: (deviceConfig && deviceConfig.language) || process.env.STT_LANGUAGE || 'auto'
      });
      const transcript = sttResult.text;
      const detectedLang = sttResult.language;

      // Answer in whatever language the caller just used.
      const previousTurnVoice = turnVoice;
      turnVoice = voiceForLanguage(detectedLang, voiceId);
      console.log('[' + new Date().toISOString() + '] WHISPER [' + (detectedLang || '?') +
        ' -> voice ' + turnVoice + ']: "' + transcript + '"');

      // Re-render the pre-warmed goodbye clip if the caller's language changed.
      if (turnVoice !== previousTurnVoice) {
        goodbyeUrlPromise = ttsService.generateSpeech("Goodbye! Call again anytime.", turnVoice);
      }

      if (!transcript || transcript.trim().length < 2) {
        const clarifyUrl = await ttsService.generateSpeech("Sorry, I didn't catch that. Could you repeat?", turnVoice);
        await endpoint.play(clarifyUrl);
        continue;
      }

      if (isGoodbye(transcript)) {
        const byeUrl = await goodbyeUrlPromise;
        await endpoint.play(byeUrl);
        break;
      }

      // Fire the Claude query immediately - everything else in this block
      // (thinking phrase, hold music/filler loop) runs concurrently with it
      // instead of blocking it, since generating+playing the thinking phrase
      // used to add its own TTS round-trip before the query even started.
      console.log('[' + new Date().toISOString() + '] CLAUDE Querying (device: ' + deviceName + ')...');
      const claudeQueryPromise = claudeBridge.query(
        transcript,
        { callId: callUuid, devicePrompt: devicePrompt }
      );

      // THINKING FEEDBACK
      const thinkingPhrase = getRandomThinkingPhrase();
      console.log('[' + new Date().toISOString() + '] THINKING: "' + thinkingPhrase + '"');
      const thinkingUrl = await ttsService.generateSpeech(thinkingPhrase, turnVoice);
      await endpoint.play(thinkingUrl);

      // hears nothing for the whole query and hangs up.
      // Fill the whole wait, not just parts of it. The gap alternates between a
      // soft music bed and a spoken line, so the line never goes dead. Clips play
      // to completion - one endpoint cannot layer two streams - and every Nth
      // round is speech instead of music.
      let waiting = true;
      const SPEAK_EVERY = parseInt(process.env.KEEPALIVE_SPEAK_EVERY || '3', 10);
      const keepAlive = (async function () {
        let round = 0;
        while (waiting) {
          round++;
          try {
            const clipUrl = (round % SPEAK_EVERY === 0)
              ? await ttsService.generateSpeech(getRandomWaitingPhrase(), turnVoice)
              : HOLD_MUSIC_URL;
            if (!waiting) break;
            // Caller can cut through the hold music / filler to add
            // something - captured and queued as the next turn's input once
            // the in-flight Claude query (already running, can't be
            // cancelled mid-flight) finishes.
            const barged = await playInterruptible(endpoint, session, clipUrl);
            if (barged) {
              pendingUtterance = barged;
              waiting = false;
              break;
            }
          } catch (e) {
            console.log('[' + new Date().toISOString() + '] KEEPALIVE: stopped (' + e.message + ')');
            return;
          }
        }
      })();

      let claudeResponse;
      try {
        claudeResponse = await claudeQueryPromise;
      } finally {
        waiting = false;
        try { await keepAlive; } catch (e) {}
      }

      console.log('[' + new Date().toISOString() + '] CLAUDE Response received');

      if (pendingUtterance) {
        // Caller already interrupted during the wait and started saying
        // something new - the answer to their original question is now
        // moot. Skip playing it and let the next loop iteration process
        // what they're actually saying now, instead of talking over/past it.
        console.log('[' + new Date().toISOString() + '] VOICE: skipped (caller already interrupted with a new utterance)');
      } else {
        // Extract and play voice line with device voice
        const voiceLine = extractVoiceLine(claudeResponse);
        console.log('[' + new Date().toISOString() + '] VOICE: "' + voiceLine + '"');

        const responseUrl = await ttsService.generateSpeech(voiceLine, turnVoice);
        // Long answers are the usual thing people want to interrupt.
        const responseBarge = await playInterruptible(endpoint, session, responseUrl);
        if (responseBarge) {
          pendingUtterance = responseBarge;
        }
      }

      console.log('[' + new Date().toISOString() + '] CONVERSATION Turn ' + turnCount + ' complete');
    }

    if (turnCount >= MAX_TURNS) {
      const maxUrl = await ttsService.generateSpeech("We've been talking for a while. Goodbye!", turnVoice);
      await endpoint.play(maxUrl);
    }

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CONVERSATION Error:', error.message);
    try {
      if (session) session.setCaptureEnabled(false);
      const errUrl = await ttsService.generateSpeech("Sorry, something went wrong.", voiceId);
      await endpoint.play(errUrl);
    } catch (e) {}
  } finally {
    console.log('[' + new Date().toISOString() + '] CONVERSATION Cleanup...');

    // Fire-and-forget: this is a host-side HTTP bookkeeping call with its own
    // multi-second timeout. Awaiting it here used to leave the call connected
    // and silent for up to 5s after the caller said goodbye, before the SIP
    // dialog was actually torn down.
    claudeBridge.endSession(callUuid).catch(function () {});

    if (forkRunning) {
      try {
        await endpoint.forkAudioStop();
      } catch (e) {}
    }

    try { dialog.destroy(); } catch (e) {}
  }
}

/**
 * Strip video tracks from SDP (FreeSWITCH doesn't support H.261 and rejects with 488)
 * Keeps only audio tracks to ensure codec negotiation succeeds
 */
function stripVideoFromSdp(sdp) {
  if (!sdp) return sdp;

  const lines = sdp.split('\r\n');
  const result = [];
  let inVideoSection = false;

  for (const line of lines) {
    // Check if we're entering a video media section
    if (line.startsWith('m=video')) {
      inVideoSection = true;
      continue; // Skip the m=video line
    }

    // Check if we're entering a new media section (audio, etc.)
    if (line.startsWith('m=') && !line.startsWith('m=video')) {
      inVideoSection = false;
    }

    // Skip all lines in the video section
    if (inVideoSection) {
      continue;
    }

    result.push(line);
  }

  return result.join('\r\n');
}

/**
 * Handle incoming SIP INVITE
 */
async function handleInvite(req, res, options) {
  const { mediaServer, deviceRegistry } = options;

  const callerId = extractCallerId(req);
  const dialedExt = extractDialedExtension(req);

  // Look up device config using deviceRegistry.get() (works with name OR extension)
  let deviceConfig = null;
  if (deviceRegistry && dialedExt) {
    deviceConfig = deviceRegistry.get(dialedExt);
    if (deviceConfig) {
      console.log('[' + new Date().toISOString() + '] CALL Device matched: ' + deviceConfig.name + ' (ext ' + dialedExt + ')');
    } else {
      console.log('[' + new Date().toISOString() + '] CALL Unknown extension ' + dialedExt + ', using default');
      deviceConfig = deviceRegistry.getDefault();
    }
  }

  console.log('[' + new Date().toISOString() + '] CALL Incoming from: ' + callerId + ' to ext: ' + (dialedExt || 'unknown'));

  try {
    // Strip video from SDP to avoid FreeSWITCH 488 error with unsupported video codecs
    const originalSdp = req.body;
    const audioOnlySdp = stripVideoFromSdp(originalSdp);
    if (originalSdp !== audioOnlySdp) {
      console.log('[' + new Date().toISOString() + '] CALL Stripped video track from SDP');
    }

    const result = await mediaServer.connectCaller(req, res, { remoteSdp: audioOnlySdp });
    const { endpoint, dialog } = result;
    const callUuid = endpoint.uuid;

    console.log('[' + new Date().toISOString() + '] CALL Connected: ' + callUuid);

    dialog.on('destroy', function() {
      console.log('[' + new Date().toISOString() + '] CALL Ended');
      if (endpoint) endpoint.destroy().catch(function() {});
    });

    await conversationLoop(endpoint, dialog, callUuid, options, deviceConfig);
    return { endpoint: endpoint, dialog: dialog, callerId: callerId, callUuid: callUuid };

  } catch (error) {
    console.error('[' + new Date().toISOString() + '] CALL Error:', error.message);
    try { res.send(500); } catch (e) {}
    throw error;
  }
}

module.exports = {
  handleInvite: handleInvite,
  extractCallerId: extractCallerId,
  extractDialedExtension: extractDialedExtension
};
