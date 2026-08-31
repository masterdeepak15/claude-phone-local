# Troubleshooting

Every failure mode below was hit for real on a Windows 11 + Docker Desktop +
native 3CX SBC setup. Each entry gives the symptom, the log line that identifies
it, and the fix.

## First: where to look

```bash
docker compose logs -f                      # everything
docker logs claude-phone 2>&1 | grep -Ei "CALL |error|503"
curl http://127.0.0.1:3333/health           # host Claude wrapper
```

Inside the container:

```bash
docker exec claude-phone bash -c 'IP=$(hostname -i|awk "{print \$1}"); \
  for p in 5070 5080 8021 3000 9001 9002; do \
    (echo >/dev/tcp/$IP/$p) 2>/dev/null && echo "$p UP" || echo "$p DOWN"; done'
```

`3000`, `9001`, `9002` bind to loopback by design and will read DOWN on the
container IP — that is correct, not a fault.

---

## Call goes straight to voicemail

**Symptom:** "Please record your message." The app never answers.

**Log:**
```
Connection refused (111) with tcp/[…]:5080
CALL Error: Sip non-success response: 503
```

drachtio could not reach FreeSWITCH, so it returned 503 and 3CX fell through to
voicemail.

**Cause and fix.** FreeSWITCH binds sofia to the **container IP**, never to
loopback, and it must *advertise* the address it actually listens on. Check the
two do not disagree:

```bash
docker exec claude-phone sh -c 'grep -E "ext_sip_ip|ext_rtp_ip" \
  /usr/local/freeswitch/conf/vars_diff.xml'
```

Expected — they are deliberately different:

```
ext_rtp_ip=172.16.14.225    <- your LAN IP, so the SBC can reach the media
ext_sip_ip=172.18.0.2       <- the container IP, where sofia actually listens
```

If `ext_sip_ip` is your LAN IP or `127.0.0.1`, drachtio dials a port with nothing
behind it. `docker/entrypoint.sh` computes the container IP at runtime; confirm
it ran:

```
[bootstrap] FreeSWITCH SIP will advertise 172.18.0.2; RTP will advertise 172.16.14.225
```

---

## Call connects but there is no audio at all

**Symptom:** the call is up, no greeting, and nothing you say registers.

**Check the SDP** that FreeSWITCH sent back:

```bash
docker logs claude-phone 2>&1 | grep "c=IN IP4"
```

- `c=IN IP4 172.16.14.225` (your LAN IP) — correct.
- `c=IN IP4 172.18.0.x` (a Docker IP) — **broken**. The SBC is a native Windows
  process and cannot route to the Docker bridge, so RTP dies in both directions.

**Cause.** FreeSWITCH's `nat.auto` ACL treats `172.16.0.0/12` as "local". Your
LAN (`172.16.x`) *and* the Docker bridge (`172.18.x`) both fall inside that
range, so FreeSWITCH decides the SBC is local and skips external-IP
substitution.

**Fix** — applied at build time in the `Dockerfile`; verify it stuck:

```bash
docker exec claude-phone grep -E "local-network-acl|apply-nat-acl" \
  /usr/local/freeswitch/conf/sip_profiles/mrf.xml
```

You want `local-network-acl = none` present and **no** `apply-nat-acl` line.

Also confirm the RTP ports are published: `30000-30100/udp` in
`docker-compose.yml`.

---

## Greeting plays, then nothing — she never answers

**Symptom:** you hear the greeting and the beep, you speak, and nothing happens
until the call times out.

**Log — the tell:**
```
LISTEN Got: … bytes
(no "Finalizing utterance" line ever appears)
```

or

```
VAD: isSpeech=true, inSpeech=true, silenceMs=0, RMS=1800, floor=…
```
repeating, with `silenceMs` never rising.

**Cause.** The VAD never sees end-of-speech. Fixed thresholds assume the line
goes to digital silence (RMS 0) between words. Through a PBX/SBC the gaps carry
a **noise floor of roughly RMS 1000–2500**, which sits above a fixed threshold,
so every frame classifies as speech and the utterance is never finalized.

**Fix.** The VAD learns the floor as a rolling 20th percentile and requires
speech to exceed it by `VAD_NOISE_MULT`. If it still misbehaves, read the
`floor=` value in the logs and adjust:

```bash
VAD_NOISE_MULT=3.0     # she keeps "hearing" your noise floor -> raise
VAD_NOISE_MULT=1.8     # she misses quiet speech -> lower
```

> An EMA that only updates on "silent" frames **cannot** fix this: if the floor
> already exceeds the threshold, no frame is ever classified silent, so the floor
> never updates. The measurement must not depend on the decision it feeds.

---

## Answers are slow (30–60s of dead air)

Break the delay down from the timestamps:

```bash
docker logs claude-phone 2>&1 | grep -E "LISTEN Got|WHISPER |CLAUDE Query|VOICE:"
```

| Stage | Healthy | If it is slower |
|---|---|---|
| `LISTEN Got` → `WHISPER` | 4s (`small`) / 14s (`medium`) | drop `WHISPER_MODEL` to `small` |
| `CLAUDE Query` → `VOICE:` | 20–45s | see below |

**The big one: MCP startup.** Every turn spawns a fresh `claude` process. Without
`--strict-mcp-config` it first connects to *every* configured MCP server —
including remote HTTP ones needing auth, which simply time out. That added ~30s
to every answer.

This is on by default now. To confirm the flag is present:

```bash
grep -n "strict-mcp-config" claude-api-server/server.js
```

Set `PHONE_ENABLE_MCP=1` only if you deliberately want MCP tools by phone, and
accept the latency.

**Diagnostic trick:** send a deliberately invalid request. If it fails in ~1s
while a valid one takes 60s, the gap is process startup (MCP), not reasoning.

---

## She says she cannot check your PC

**Symptom:** *"I'm running on the server side, not your computer."* — untrue. She
runs as Claude Code **on your PC** with full shell access.

**Fix.** The device prompt must tell her so. In `data/config/devices.json`:

```json
"prompt": "You are Maya… You are running as Claude Code directly on the user's
Windows PC, with full shell and file access. When asked about their PC, actually
RUN a command and report the real result. Never say you cannot check."
```

Restart the container (config is a volume, no rebuild needed):
```bash
docker compose restart claude-phone
```

---

## Container restart-loops immediately

**Log:**
```
/usr/bin/env: 'bash\r': No such file or directory
```

**Cause.** CRLF line endings — a Windows checkout or a Windows editor saved
`docker/entrypoint.sh` with `\r\n`, making the shebang `bash\r`.

**Fix.** The `Dockerfile` strips CR at build time and `.gitattributes` forces LF.
If you hit it anyway:

```bash
sed -i 's/\r$//' docker/entrypoint.sh docker/supervisord.conf
docker compose build && docker compose up -d
```

---

## SIP registration fails

**403 Invalid credentials** — you are registering against the wrong host. Send
REGISTER to the **local SBC**, not the cloud tenant:

```
SIP_DOMAIN=1752.3cx.cloud      # identity, used in From/To
SIP_REGISTRAR=172.16.14.225    # where REGISTER actually goes (the local SBC)
```

**Port 5060 already in use** — the 3CX SBC owns it. drachtio uses **5070**; keep
`DRACHTIO_SIP_PORT=5070` and the matching published port.

Verify registration:
```bash
docker logs claude-phone 2>&1 | grep MULTI-REGISTRAR
# [MULTI-REGISTRAR] Maya SUCCESS - Registered as ext 17512
```

---

## Models re-download on every restart

`./data` is not persisting. A healthy restart logs:

```
[bootstrap] voice en_US-lessac-medium already present
[bootstrap] whisper model cached
[bootstrap] devices.json already present (left untouched)
```

Check the bind mount is `./data:/data` in `docker-compose.yml`, that `data/` is
in `.gitignore`, and that Docker Desktop has file sharing enabled for the drive.

---

## Wrong language, or garbled Hindi/Marathi

```bash
docker logs claude-phone 2>&1 | grep "WHISPER \["
# WHISPER [hi -> voice hi_IN-priyamvada-medium]: "…"
```

- **Wrong language detected** — pin it: `STT_LANGUAGE=hi` (or `mr`, `en`).
- **Right language, garbled words** — `WHISPER_MODEL=medium` at minimum.
  Marathi is the weakest of the three; `large-v3` helps but is ~3 GB and much
  slower per turn on CPU.
- **Correct text, wrong voice** — check `LANG_VOICE_MAP` and that the model
  exists: `curl http://127.0.0.1:9002/voices`.

---

## She talks over me / I cannot interrupt her

Barge-in is deliberately hard to trigger so a cough or echo cannot cut her off.

```bash
docker logs claude-phone 2>&1 | grep "BARGE-IN"
```

- **Never triggers** — lower `BARGE_MULT` (1.6 → 1.3) or `BARGE_MIN_MS` (320 → 200).
- **Triggers on its own** — raise them. If it fires while *she* is speaking, the
  audio fork is carrying her own audio back; confirm `mixType: 'mono'` in
  `sip-handler.js`.

---

## Falling back to the old layout

The previous five-container setup is preserved and still works:

```bash
docker compose down
docker compose -f docker-compose.multi.yml up -d
```

Note it needs the container-DNS env values (`DRACHTIO_HOST=drachtio`,
`FREESWITCH_HOST=freeswitch`, `AUDIO_BASE_URL=http://voice-app:3000`), which the
unified `docker-compose.yml` overrides to `127.0.0.1`.
