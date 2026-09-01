import net from 'net';
import http from 'http';

/**
 * Check if an IP address is reachable on the network
 * @param {string} ip - IP address to check
 * @param {number} [port=3333] - Port to check (defaults to API server port)
 * @param {number} [timeout=3000] - Timeout in milliseconds
 * @returns {Promise<boolean>} True if IP is reachable
 */
export async function isReachable(ip, port = 3333, timeout = 3000) {
  return new Promise((resolve) => {
    // Validate IP format first
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(ip)) {
      resolve(false);
      return;
    }

    const socket = new net.Socket();

    // Set timeout
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.destroy();

      // ECONNREFUSED means the IP is reachable but nothing is listening on that port
      // This is actually a GOOD sign - the IP responded
      if (err.code === 'ECONNREFUSED') {
        resolve(true);
      } else {
        // ETIMEDOUT, EHOSTUNREACH, etc. mean IP is not reachable
        resolve(false);
      }
    });

    // Connect to the specified port (default 3333 for API server)
    socket.connect(port, ip);
  });
}

/**
 * Check if claude-api-server is responding at a given URL
 * @param {string} url - Full URL to claude-api-server (e.g., http://192.168.1.100:3333)
 * @returns {Promise<object>} Check result
 * @property {boolean} reachable - True if server is reachable
 * @property {boolean} [healthy] - True if server responds with success (only if reachable)
 * @property {string} [error] - Error message if check failed
 */
export async function checkClaudeApiServer(url) {
  return new Promise((resolve) => {
    try {
      // Validate URL format
      // URL is a global in Node.js (no import needed)
      // eslint-disable-next-line no-undef, no-new
      new URL(url);

      // Try to reach /health endpoint (or root if /health doesn't exist)
      const healthUrl = url + '/health';

      const req = http.get(healthUrl, { timeout: 3000 }, (res) => {
        // Server is reachable
        const healthy = res.statusCode >= 200 && res.statusCode < 400;

        resolve({
          reachable: true,
          healthy: healthy,
          statusCode: res.statusCode
        });

        // Consume response to free up memory
        res.resume();
      });

      req.on('error', (err) => {
        // Connection error - server not reachable
        resolve({
          reachable: false,
          error: err.message
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          reachable: false,
          error: 'Connection timeout'
        });
      });
    } catch (err) {
      // Invalid URL format
      resolve({
        reachable: false,
        error: err.message
      });
    }
  });
}

/**
 * Poll voice-app's /health until it reports drachtio + FreeSWITCH both
 * connected, or the timeout elapses. Fixes `claude-phone start` reporting
 * "All services running!" while FreeSWITCH is still booting - a call landing
 * in that gap gets a SIP 503 and falls through to the 3CX generic voicemail
 * prompt instead of ever reaching the app.
 * @param {string} url - voice-app base URL (e.g. http://localhost:3000)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] - Give up after this long
 * @param {number} [opts.intervalMs=1000] - Poll interval
 * @returns {Promise<{ready: boolean, timedOut: boolean}>}
 */
export async function waitForVoiceAppReady(url, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const req = http.get(url + '/health', { timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(Boolean(JSON.parse(body).ready));
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });

    if (ready) return { ready: true, timedOut: false };
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return { ready: false, timedOut: true };
}
