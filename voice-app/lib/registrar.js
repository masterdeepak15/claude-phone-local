const Srf = require('drachtio-srf');

/**
 * Handles SIP Registration (UAC) with 3CX
 * 
 * 3CX requires:
 * - From/To/Contact: Use EXTENSION NUMBER (e.g., 5756)
 * - Auth credentials: Use AUTH ID + PASSWORD (e.g., pEmNzYscb4)
 */
class Registrar {
  constructor(srf, config) {
    this.srf = srf;
    this.config = config;

    // Extension number for From/To/Contact headers
    this.extension = config.extension;

    // Auth credentials (separate from extension)
    this.authId = config.auth_id;
    this.password = config.password;

    // Server addresses
    this.domain = config.domain; // 3CX server address
    this.registrar = config.registrar; // Usually same as domain
    this.registrarPort = config.registrar_port || 5060;

    // Local address (populated from connect event)
    this.localAddress = config.local_address || 'localhost';

    // Registration state
    this.expiry = config.expiry || 3600;
    this.timer = null;
    this.registered = false;
  }

  start() {
    console.log('[REGISTRAR] Starting registration:');
    console.log('  Extension: ' + this.extension + '@' + this.domain);
    console.log('  Auth ID: ' + this.authId);
    console.log('  Registrar: ' + this.registrar + ':' + this.registrarPort);
    console.log('  Contact: ' + this.extension + '@' + this.localAddress);
    this._attemptRegistration();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.registered = false;
    console.log('[REGISTRAR] Stopped registration loop');
  }

  isRegistered() {
    return this.registered;
  }

  _attemptRegistration() {
    const registrarUri = 'sip:' + this.registrar + ':' + this.registrarPort;

    // From/To use EXTENSION number, not auth ID
    const fromUri = 'sip:' + this.extension + '@' + this.domain;

    // Contact uses local address
    const contactUri = 'sip:' + this.extension + '@' + this.localAddress;

    console.log('[REGISTRAR] Sending REGISTER to ' + registrarUri);
    console.log('  From: ' + fromUri);
    console.log('  Contact: ' + contactUri);

    try {
      this.srf.request(registrarUri, {
        method: 'REGISTER',
        headers: {
          'From': '<' + fromUri + '>',
          'To': '<' + fromUri + '>',
          'Contact': '<' + contactUri + '>;expires=' + this.expiry,
          'Expires': this.expiry.toString(),
          'User-Agent': 'ClaudePhoneLocal-VoiceServer/1.0'
        },
        auth: {
          username: this.authId, // AUTH ID, not extension
          password: this.password
        }
      }, (err, req) => {
        if (err) {
          console.error('[REGISTRAR] Request Error: ' + err.message);
          this._scheduleRetry(60);
          return;
        }

        req.on('response', (res) => {
          console.log('[REGISTRAR] Response: ' + res.status + ' ' + res.reason);

          if (res.status === 200) {
            console.log('[REGISTRAR] SUCCESS - Registered as extension ' + this.extension);
            this.registered = true;

            // Parse granted expiry from Contact or Expires header
            var grantedExpires = this.expiry;
            var contactHeader = res.get('Contact');
            var expiresHeader = res.get('Expires');

            if (contactHeader) {
              var match = contactHeader.match(/expires=(\d+)/i);
              if (match) grantedExpires = parseInt(match[1]);
            } else if (expiresHeader) {
              grantedExpires = parseInt(expiresHeader);
            }

            // Refresh at 90% of expiry, minimum 30 seconds
            var refreshTime = Math.max(30, Math.floor(grantedExpires * 0.9));
            console.log('[REGISTRAR] Next refresh in ' + refreshTime + 's (granted ' + grantedExpires + 's)');
            this._scheduleRetry(refreshTime);

          } else if (res.status === 401 || res.status === 407) {
            // drachtio should handle this automatically with auth object
            // If we're seeing this, auth failed
            console.error('[REGISTRAR] Auth challenge received - credentials may be wrong');
            console.error('  Auth ID used: ' + this.authId);
            this.registered = false;
            this._scheduleRetry(60);

          } else if (res.status >= 300) {
            console.error('[REGISTRAR] FAILED: ' + res.status + ' ' + res.reason);
            this.registered = false;
            this._scheduleRetry(60);
          }
        });
      });
    } catch (err) {
      console.error('[REGISTRAR] Exception: ' + err.message);
      this._scheduleRetry(60);
    }
  }

  _scheduleRetry(seconds) {
    if (this.timer) clearTimeout(this.timer);
    console.log('[REGISTRAR] Scheduling retry in ' + seconds + 's');
    this.timer = setTimeout(() => this._attemptRegistration(), seconds * 1000);
  }
}

module.exports = Registrar;
