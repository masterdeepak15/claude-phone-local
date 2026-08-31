FROM python:3.11-slim

WORKDIR /app
RUN pip install --no-cache-dir fastapi uvicorn[standard] piper-tts

COPY server.py /app/server.py

EXPOSE 9002
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9002"]
