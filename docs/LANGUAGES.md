# Languages — English, Hindi, Marathi

Speech is fully offline in all three. Whisper detects the language of each
utterance, and the reply comes back in that same language with a matching voice.

## How it works

```
you speak
   → faster-whisper transcribes AND reports the language code  (hi / mr / en)
   → the code picks a Piper voice from LANG_VOICE_MAP
   → Claude is instructed to reply in the same language
   → Piper speaks it in that voice
```

Detection is **per utterance**, so you can switch language mid-call and she
follows.

## Configuration

```bash
STT_LANGUAGE=auto          # detect per utterance; or pin to en | hi | mr
SUPPORTED_LANGS=en,hi,mr   # languages we will answer in
LANG_VOICE_MAP={"en":"en_US-lessac-medium","hi":"hi_IN-priyamvada-medium","mr":"mr_IN-google-medium"}
WHISPER_MODEL=medium       # see accuracy below
```

`SUPPORTED_LANGS` is a safety net, not decoration. Whisper can return any of
~99 codes but only the installed voices exist on disk. A code outside this list
falls back to the device voice, so a misdetection — `ne` for Marathi is very
plausible, both are Devanagari — costs you the wrong accent rather than a 404
mid-call.

## Voices

Downloaded automatically on first run into `data/voices/`:

| Language | Voice | Size |
|---|---|---|
| English | `en_US-lessac-medium` | 61 MB |
| Hindi | `hi_IN-priyamvada-medium` | 61 MB |
| Marathi | `mr_IN-google-medium` | 73 MB |

Change the set with `PIPER_VOICES` (space-separated) in `.env`; the entrypoint
resolves each name to its path in the
[rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) repo.

Other English voices worth trying: `en_US-amy-medium`, `en_US-kristin-medium`,
`en_US-hfc_female-medium`, `en_US-ryan-high`.

```bash
curl http://127.0.0.1:9002/voices   # what is actually installed
```

## Accuracy — read this before judging Marathi

Measured on this stack:

| Language | `small` | `medium` |
|---|---|---|
| English | good | very good |
| Hindi | fair | **very good** |
| Marathi | poor | **fair** |

Whisper's Marathi training data is thin compared with Hindi. Detection is
reliable in both; it is the *words* that suffer in Marathi.

`large-v3` improves Marathi noticeably but is ~3 GB and materially slower per
turn on CPU — a real cost on a live call, where every second is dead air.

## The speed/accuracy trade-off

`WHISPER_MODEL` is the single biggest latency lever:

| Model | Transcription | Notes |
|---|---|---|
| `small` | ~4s | fine for English, weak on Marathi |
| `medium` | ~14s | needed for solid Hindi/Marathi |
| `large-v3` | ~40s+ | best accuracy, painful on a phone call |

If you mostly speak English, `small` makes calls feel dramatically snappier.
Keep `medium` while testing the Indian languages.

## Making her reply in the right language

Transcription alone is not enough — Claude has to be told, or she will answer a
Hindi question in English. The device prompt in `data/config/devices.json`
handles it:

> ALWAYS reply in the same language the user just used, using that language's
> native script (Devanagari for Hindi and Marathi). Never transliterate.

The "never transliterate" clause matters: Piper's Hindi and Marathi voices read
**Devanagari**. Hand them romanised Hindi ("aap kaise hain") and you get an
English speaker mangling syllables.

## Ending a call

Goodbye phrases are recognised in all three languages, including
`बंद करो`, `फोन बंद करो`, `ठेवतो`, `अलविदा`, `बाय`, plus romanised forms
(`band karo`, `alvida`). See `goodbyePhrases` in `voice-app/lib/sip-handler.js`.

## Adding another language

1. Find a voice in the [Piper catalogue](https://huggingface.co/rhasspy/piper-voices)
   (56 languages available).
2. Add its name to `PIPER_VOICES` in `.env`.
3. Add the Whisper code → voice mapping to `LANG_VOICE_MAP`.
4. Add the code to `SUPPORTED_LANGS`.
5. Add goodbye phrases for it in `sip-handler.js`.
6. `docker compose restart claude-phone` — the entrypoint downloads it on boot.

No image rebuild is needed; voices live on the `./data` volume.
