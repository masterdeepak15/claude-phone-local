# claude-phone-local - single image containing all five services.
#
# Layout:
#   FreeSWITCH  : from the drachtio MRF base image (already compiled)
#   drachtio    : binary lifted from the official drachtio-server image
#   Node 20     : copied from node:20-slim into /opt/node
#   Python venv : /opt/venv with faster-whisper (STT) + piper-tts (TTS)
#   supervisord : runs all five as one container
#
# All persistent state lives in /data (voices, models, audio, config) so a
# `docker compose down && up` never re-downloads anything.

FROM drachtio/drachtio-server AS drachtio
FROM node:20-slim AS nodesrc

FROM drachtio/drachtio-freeswitch-mrf

ENV DEBIAN_FRONTEND=noninteractive

# drachtio needs these boost/tcmalloc libs, which the FreeSWITCH image lacks.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libboost-thread1.74.0 \
      libboost-log1.74.0 \
      libboost-filesystem1.74.0 \
      libgoogle-perftools4 \
      python3 python3-venv \
      supervisor curl ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=drachtio /usr/local/bin/drachtio /usr/local/bin/drachtio
# drachtio refuses to start without its config file, even when every setting
# is supplied on the command line.
COPY --from=drachtio /etc/drachtio.conf.xml /etc/drachtio.conf.xml
RUN ldd /usr/local/bin/drachtio | grep "not found" && exit 1 || echo "drachtio libs OK"

# Node into /opt/node so it cannot collide with /usr/local/freeswitch
COPY --from=nodesrc /usr/local/bin/node /opt/node/bin/node
COPY --from=nodesrc /usr/local/lib/node_modules /opt/node/lib/node_modules
RUN ln -sf /opt/node/bin/node /usr/bin/node \
 && ln -sf /opt/node/lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm \
 && node --version && npm --version

# Python services
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir \
      fastapi "uvicorn[standard]" python-multipart faster-whisper piper-tts
# piper CLI must be on PATH for the TTS sidecar to shell out to it
RUN ln -sf /opt/venv/bin/piper /usr/bin/piper

COPY stt-local/server.py /opt/stt/server.py
COPY tts-local/server.py /opt/tts/server.py

# Node app (deps first for layer caching)
WORKDIR /app
COPY voice-app/package*.json ./
RUN npm install --omit=dev
COPY voice-app/ ./

# FreeSWITCH NAT fixes, carried over from the old compose file.
#  - apply-nat-acl "nat.auto" treats 172.16/12 as local. The LAN (172.16.x) and
#    the Docker bridge (172.18.x) both fall in that range, so FreeSWITCH decided
#    the 3CX SBC was local and skipped external-IP substitution, putting the
#    container IP in the SDP and breaking RTP in both directions.
#  - local-network-acl "none" stops any further "this peer is local" guessing.
RUN sed -i '/apply-nat-acl/d' /usr/local/freeswitch/conf/sip_profiles/mrf.xml  && sed -i '/<param name="ext-sip-ip"/a\      <param name="local-network-acl" value="none"/>'       /usr/local/freeswitch/conf/sip_profiles/mrf.xml  && grep -q 'local-network-acl' /usr/local/freeswitch/conf/sip_profiles/mrf.xml  && echo "mrf.xml NAT patches applied"

COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/entrypoint.sh /usr/local/bin/claude-phone-entrypoint
# Windows checkouts can introduce CRLF, which makes the shebang "bash"
# and the container restart-loops. Normalise before making it executable.
RUN tr -d '' < /usr/local/bin/claude-phone-entrypoint > /tmp/e && mv /tmp/e /usr/local/bin/claude-phone-entrypoint && tr -d '' < /etc/supervisor/supervisord.conf > /tmp/s && mv /tmp/s /etc/supervisor/supervisord.conf && chmod +x /usr/local/bin/claude-phone-entrypoint

# voice-app writes generated audio here and reads devices.json from here
ENV AUDIO_DIR=/data/audio \
    PIPER_VOICES_DIR=/data/voices \
    HF_HOME=/data/models/huggingface \
    DEVICES_CONFIG=/data/config/devices.json
RUN rm -rf /app/config && ln -s /data/config /app/config \
 && rm -rf /app/audio && ln -s /data/audio /app/audio

EXPOSE 3000 3001 5070/udp 5070/tcp 5080/udp 5080/tcp 30000-30100/udp

ENTRYPOINT ["/usr/local/bin/claude-phone-entrypoint"]
