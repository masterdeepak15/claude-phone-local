/**
 * Claude HTTP API Server
 *
 * HTTP server that wraps Claude Code with session management, for the voice
 * interface to query.
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /ask - Send a prompt to Claude (with optional callId for session)
 *   POST /ask-structured - Send a prompt, get back validated JSON (n8n)
 *   POST /end-session - Clean up session for a call
 *   GET /health - Health check
 *
 * /ask runs on a persistent Claude Agent SDK session per callId (one
 * `query()` process for the whole phone call, fed via an async queue) instead
 * of spawning a fresh `claude` CLI process per turn. Process boot/init was a
 * fixed multi-second tax on every single turn even with --resume restoring
 * history - noticeable as "why does she pause before even starting to think"
 * on every call. /ask-structured (n8n/automation, not latency-sensitive,
 * needs its own retry-with-repair-prompt loop) still spawns the CLI per call.
 */

import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildQueryContext,
  buildStructuredPrompt,
  tryParseJsonFromText,
  validateRequiredFields,
  buildRepairPrompt,
} from './structured.js';

const app = express();
const PORT = process.env.PORT || 3333;

/**
 * Build the full environment that Claude Code expects
 * This mimics what happens when you run `claude` in a terminal
 * with your zsh profile fully loaded.
 */
function buildClaudeEnvironment() {
  const HOME = process.env.HOME || process.env.USERPROFILE || '/root';
  const PAI_DIR = path.join(HOME, '.claude');

  // Load ~/.claude/.env (all API keys)
  const envPath = path.join(PAI_DIR, '.env');
  const paiEnv = {};
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          paiEnv[key] = valueParts.join('=');
        }
      }
    }
  }

  // Build PATH like zsh profile does (mac/Linux). On Windows, the existing
  // process PATH already resolves `claude`, `node`, etc. - don't stomp it.
  const isWindows = process.platform === 'win32';
  const fullPath = isWindows
    ? process.env.PATH
    : [
      '/opt/homebrew/bin',
      '/opt/homebrew/opt/python@3.12/bin',
      '/opt/homebrew/opt/libpq/bin',
      path.join(HOME, '.bun/bin'),
      path.join(HOME, '.local/bin'),
      path.join(HOME, '.pyenv/bin'),
      path.join(HOME, '.pyenv/shims'),
      path.join(HOME, 'go/bin'),
      '/usr/local/go/bin',
      path.join(HOME, 'bin'),
      path.join(HOME, '.lmstudio/bin'),
      path.join(HOME, '.opencode/bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ].join(':');

  const env = {
    ...process.env,
    ...paiEnv,
    PATH: fullPath,
    HOME,
    PAI_DIR,
    PAI_HOME: HOME,
    DA: 'Morpheus',
    DA_COLOR: 'purple',
    GOROOT: '/usr/local/go',
    GOPATH: path.join(HOME, 'go'),
    PYENV_ROOT: path.join(HOME, '.pyenv'),
    BUN_INSTALL: path.join(HOME, '.bun'),
    // CRITICAL: These tell Claude Code it's running in the proper environment
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  };

  // CRITICAL: Only remove ANTHROPIC_API_KEY when NOT using custom API proxy
  // If ANTHROPIC_BASE_URL or CLAUDE_USE_API_KEY is set, keep the key for proxy auth
  // Otherwise delete it so Claude CLI uses subscription auth
  if (!env.ANTHROPIC_BASE_URL && !env.CLAUDE_USE_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
  }

  return env;
}

// Pre-build the environment once at startup
const claudeEnv = buildClaudeEnvironment();

// Every phone turn used to spawn a fresh CLI process. Without
// --strict-mcp-config it tries to connect to every configured MCP server
// first - including remote HTTP ones that need auth and simply time out -
// which added ~30-60s of dead air to each answer. The phone agent does not
// need them. Set PHONE_ENABLE_MCP=1 if you deliberately want MCP tools
// available over the phone.
const STRICT_MCP = process.env.PHONE_ENABLE_MCP !== '1';

/**
 * Resolve the Claude model to use.
 *
 * OmniRoute / custom API proxies often don't support `claude-sonnet-5`.
 * Set CLAUDE_MODEL to the proxy's model id, or to "" / "default" / "none"
 * to omit --model entirely and let Claude Code / OmniRoute pick its own.
 *
 * Request bodies may also pass `model` to override per-call.
 */
function resolveClaudeModel(requestModel) {
  const fallback = (process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_USE_API_KEY) ? 'default' : 'claude-sonnet-5';
  const raw = (requestModel !== undefined && requestModel !== null && String(requestModel).trim() !== '')
    ? String(requestModel).trim()
    : (process.env.CLAUDE_MODEL !== undefined ? process.env.CLAUDE_MODEL : fallback);
  const value = String(raw).trim();
  if (!value || value.toLowerCase() === 'default' || value.toLowerCase() === 'none') {
    return null; // omit --model / SDK model option
  }
  return value;
}

const CLAUDE_MODEL = resolveClaudeModel();

console.log('[STARTUP] Loaded environment with', Object.keys(claudeEnv).length, 'variables');
console.log('[STARTUP] PATH includes:', claudeEnv.PATH.split(':').slice(0, 5).join(', '), '...');

// Log which API keys are available (without showing values)
const apiKeys = Object.keys(claudeEnv).filter(k =>
  k.includes('API_KEY') || k.includes('TOKEN') || k.includes('SECRET') || k === 'PAI_DIR'
);
console.log('[STARTUP] API keys loaded:', apiKeys.join(', '));
console.log('[STARTUP] Claude model:', CLAUDE_MODEL || 'default (Claude Code / OmniRoute)');
console.log('[STARTUP] ANTHROPIC_BASE_URL:', claudeEnv.ANTHROPIC_BASE_URL || '(not set — subscription auth)');
console.log('[STARTUP] ANTHROPIC_API_KEY:', claudeEnv.ANTHROPIC_API_KEY ? 'kept (proxy auth)' : 'stripped (subscription auth)');

/**
 * Voice Context - Prepended to all voice queries
 *
 * This tells Claude how to handle voice-specific patterns:
 * - Output VOICE_RESPONSE for TTS (conversational, 40 words max)
 * - Output COMPLETED for status logging (12 words max)
 * - For Slack delivery requests: do the work, send to Slack, then acknowledge
 */
const VOICE_CONTEXT = `[VOICE CALL CONTEXT]
This query comes via voice call. You MUST include BOTH of these lines in your response:

🗣️ VOICE_RESPONSE: [Your conversational answer, spoken aloud via TTS. Be natural and helpful, like talking to a friend. Keep it as tight as the answer allows - a yes/no or a quick fact might be one sentence, but if the caller asked something that genuinely needs more (multiple steps, several items, an explanation), take the space to answer it properly instead of truncating. Don't pad it, but don't cut off partway through a real answer either - target roughly 2-4 sentences for anything non-trivial, more if the content actually requires it.]

🎯 COMPLETED: [Status summary in 12 words or less. This is for logging only.]

IMPORTANT: The VOICE_RESPONSE line is what the caller HEARS. Make it conversational and complete - don't just say "Done" or "Task completed". Actually answer their question or confirm what you did in a natural way. A short question deserves a short answer, but never sacrifice a complete answer just to hit a word count.

SLACK DELIVERY: When the caller requests delivery to Slack (phrases like "send to Slack", "post to #channel", "message me when done"):
1. Do the requested work (research, generate content, analyze, etc.)
2. Send results to the specified Slack channel using the Slack skill
3. Include a VOICE_RESPONSE like: "Done! I sent the weather info to the 508 channel."

The caller may hang up while you're working (they'll hear hold music). That's fine - complete the work and send to Slack. They'll see it there.

END OF CALL: The phone app matches a fixed list of goodbye words (bye, goodbye, hang up, etc.) to end the call automatically, so it misses anything phrased differently - "that's everything, thanks", "I'm all set", "nothing else for now", "we're done here". You understand intent better than a keyword match does, so ALSO add a third line whenever the caller's message signals the conversation is actually finished (a clear goodbye/thanks-and-done in any wording, in any language) - not for a mid-conversation pause, not for "give me a second", not merely because their immediate question was answered:

🔚 END_CALL: true

Omit this line entirely (do not write "false") on every turn that isn't a real goodbye - most turns won't have it.

Example query: "What's the weather in Royce City?"
Example response:
🗣️ VOICE_RESPONSE: It's 65 degrees and partly cloudy in Royce City right now. Great weather for being outside!
🎯 COMPLETED: Weather lookup for Royce City done.

Example query: "Great, that's everything, thanks!"
Example response:
🗣️ VOICE_RESPONSE: You're welcome! Have a great day.
🎯 COMPLETED: Caller signed off, no further requests.
🔚 END_CALL: true
[END VOICE CONTEXT]

`;

// ============================================================
// Persistent per-call Claude Agent SDK sessions (used by /ask)
// ============================================================
//
// One query() call is spawned per callId on its first turn, and kept alive
// for the rest of the phone call. Each subsequent /ask for that callId
// pushes a new user message into the session's async queue instead of
// spawning a new process - the SDK's streaming-input mode (prompt: an
// AsyncIterable) is designed for exactly this: a long-lived interactive
// session fed turn-by-turn.

/** @type {Map<string, CallSession>} */
const callSessions = new Map();

class CallSession {
  constructor(callId, model = CLAUDE_MODEL) {
    this.callId = callId;
    this.model = model;
    this._queue = [];
    this._queueWaiters = [];
    this._ended = false;
    this._pendingResultResolvers = [];

    const options = {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      strictMcpConfig: STRICT_MCP,
    };
    // Omit model so Claude Code / OmniRoute uses its own default
    if (model) options.model = model;

    this.query = query({
      prompt: this._messageGenerator(),
      options,
    });

    this._consumeLoop().catch((err) => {
      console.error(`[${new Date().toISOString()}] SDK session ${callId} consume loop crashed:`, err.message);
      this._failAllPending(err);
    });
  }

  async *_messageGenerator() {
    while (true) {
      if (this._queue.length === 0) {
        if (this._ended) return;
        await new Promise((resolve) => this._queueWaiters.push(resolve));
        continue;
      }
      const next = this._queue.shift();
      if (next === null) return; // end-of-session sentinel
      yield next;
    }
  }

  _wakeGenerator() {
    const waiters = this._queueWaiters;
    this._queueWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Push a user turn and resolve once its result message arrives. */
  sendMessage(text) {
    return new Promise((resolve, reject) => {
      this._pendingResultResolvers.push({ resolve, reject });
      this._queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      });
      this._wakeGenerator();
    });
  }

  async _consumeLoop() {
    for await (const message of this.query) {
      if (message.type === 'result') {
        const pending = this._pendingResultResolvers.shift();
        if (pending) pending.resolve(message);
        continue;
      }
      // Other message types (assistant text/tool_use, system init, etc.) are
      // available here for future streaming-to-caller work, but /ask only
      // needs the final result per turn today.
    }
  }

  _failAllPending(err) {
    const pending = this._pendingResultResolvers.splice(0);
    pending.forEach((p) => p.reject(err));
  }

  /** End the session: closes the generator so the underlying process exits. */
  end() {
    this._ended = true;
    this._queue.push(null);
    this._wakeGenerator();
    this._failAllPending(new Error('Session ended'));
  }
}

function getOrCreateSession(callId, model = CLAUDE_MODEL) {
  let session = callSessions.get(callId);
  if (!session) {
    session = new CallSession(callId, model);
    callSessions.set(callId, session);
    console.log(`[${new Date().toISOString()}] SDK session started: ${callId} (model=${model || 'default'})`);
  }
  return session;
}

// ============================================================
// One-shot CLI path (used by /ask-structured only)
// ============================================================

function parseClaudeStdout(stdout) {
  // Claude Code CLI may output JSONL; when it does, extract the `result` message.
  // Otherwise, fall back to raw stdout.
  let response = '';
  let sessionId = null;

  try {
    const lines = String(stdout || '').trim().split('\n');
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result' && parsed.result) {
          response = parsed.result;
          sessionId = parsed.session_id;
        }
      } catch {
        // Not JSONL; ignore.
      }
    }

    if (!response) response = String(stdout || '').trim();
  } catch {
    response = String(stdout || '').trim();
  }

  return { response, sessionId };
}

// Session storage for the one-shot /ask-structured path only.
const structuredSessions = new Map();

function runClaudeOnce({ fullPrompt, callId, timestamp, model = CLAUDE_MODEL }) {
  const startTime = Date.now();

  const args = [
    '--dangerously-skip-permissions',
    ...(STRICT_MCP ? ['--strict-mcp-config'] : []),
    '-p', fullPrompt,
  ];
  // Omit --model so Claude Code / OmniRoute uses its own default
  if (model) args.push('--model', model);

  if (callId) {
    if (structuredSessions.has(callId)) {
      args.push('--resume', callId);
      console.log(`[${timestamp}] Resuming structured session: ${callId}`);
    } else {
      args.push('--session-id', callId);
      structuredSessions.set(callId, true);
      console.log(`[${timestamp}] Starting new structured session: ${callId}`);
    }
  }

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: claudeEnv
    });

    let stdout = '';
    let stderr = '';

    claude.stdin.end();
    claude.stdout.on('data', (data) => { stdout += data.toString(); });
    claude.stderr.on('data', (data) => { stderr += data.toString(); });

    claude.on('error', (error) => {
      reject(error);
    });

    claude.on('close', (code) => {
      const duration_ms = Date.now() - startTime;
      resolve({ code, stdout, stderr, duration_ms });
    });
  });
}

// Middleware
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

/**
 * POST /ask
 *
 * Request body:
 *   {
 *     "prompt": "What Docker containers are running?",
 *     "callId": "optional-call-uuid",
 *     "devicePrompt": "optional device-specific prompt",
 *     "model": "optional model override (or \"default\" to omit --model)"
 *   }
 *
 * Response:
 *   { "success": true, "response": "...", "duration_ms": 1234, "sessionId": "..." }
 *
 * Session Management:
 *   - callId maps to a persistent Claude Agent SDK session (one query()
 *     process for the whole call, kept alive across turns via a message
 *     queue) - see CallSession above. No callId means a short-lived
 *     single-turn session that's discarded right after.
 *
 * Device Prompts:
 *   - If devicePrompt is provided, it's prepended before VOICE_CONTEXT
 *   - This allows each device (NAS, Proxmox, etc.) to have its own identity and skills
 */
app.post('/ask', async (req, res) => {
  const { prompt, callId, devicePrompt, model: requestModel } = req.body;
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const model = resolveClaudeModel(requestModel);

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: 'Missing prompt in request body'
    });
  }

  console.log(`[${timestamp}] QUERY: "${prompt.substring(0, 100)}..."`);
  console.log(`[${timestamp}] MODEL: ${model || 'default (Claude Code / OmniRoute)'}`);
  console.log(`[${timestamp}] SESSION: callId=${callId || 'none'}, existing=${callId ? callSessions.has(callId) : false}`);
  console.log(`[${timestamp}] DEVICE PROMPT: ${devicePrompt ? 'Yes (' + devicePrompt.substring(0, 30) + '...)' : 'No'}`);

  try {
    /**
     * Prompt layering order:
     * 1. Device prompt (if provided) - identity and available skills
     * 2. VOICE_CONTEXT - general voice call instructions
     * 3. User's prompt - what they actually said
     *
     * Only sent on the FIRST turn of a session - the persistent SDK session
     * already has this in its history for later turns, so resending it
     * every turn would just be redundant tokens (the CLI's --resume worked
     * the same way: system framing lived in turn 1's prompt).
     */
    const session = callId ? getOrCreateSession(callId, model) : null;

    let fullPrompt = '';
    if (!session || session._sentContext !== true) {
      if (devicePrompt) {
        fullPrompt += `[DEVICE IDENTITY]\n${devicePrompt}\n[END DEVICE IDENTITY]\n\n`;
      }
      fullPrompt += VOICE_CONTEXT;
      if (session) session._sentContext = true;
    }
    fullPrompt += prompt;

    const activeSession = session || getOrCreateSession(`__oneshot_${startTime}_${Math.random().toString(36).slice(2)}`, model);

    const result = await activeSession.sendMessage(fullPrompt);

    if (!session) {
      // Anonymous one-shot call - the session has no future turns, end it now.
      activeSession.end();
      callSessions.delete(activeSession.callId);
    }

    const duration_ms = Date.now() - startTime;

    if (result.is_error) {
      console.error(`[${new Date().toISOString()}] ERROR: Claude session reported an error result`);
      console.error(`RESULT: ${result.result}`);
      return res.json({ success: false, error: `Claude error: ${result.result}`, duration_ms });
    }

    const response = result.result || '';

    console.log(`[${new Date().toISOString()}] RESPONSE (${duration_ms}ms): "${response.substring(0, 100)}..."`);

    res.json({ success: true, response, sessionId: result.session_id, duration_ms });

  } catch (error) {
    const duration_ms = Date.now() - startTime;
    console.error(`[${timestamp}] ERROR:`, error.message);

    res.json({
      success: false,
      error: error.message,
      duration_ms
    });
  }
});

/**
 * POST /ask-structured
 *
 * Like /ask, but returns machine-validated JSON for n8n automations. Spawns
 * a fresh CLI process per call (not the persistent SDK session /ask uses) -
 * this endpoint isn't latency-sensitive the way live phone calls are, and
 * its retry-with-repair-prompt loop is a natural fit for one-shot calls.
 *
 * Request body:
 *   {
 *     "prompt": "Check Ceph health",
 *     "callId": "optional-call-uuid",
 *     "devicePrompt": "optional device-specific prompt",
 *     "schema": {
 *        "queryType": "ceph_health",
 *        "requiredFields": ["cluster_status","ssd_usage_percent","recommendation"],
 *        "fieldGuidance": { "cluster_status": "Ceph overall health, e.g. HEALTH_OK/HEALTH_WARN/HEALTH_ERR" },
 *        "allowExtraFields": true,
 *        "example": { "cluster_status": "HEALTH_WARN", "ssd_usage_percent": 88, "recommendation": "alert" }
 *     },
 *     "includeVoiceContext": false,
 *     "maxRetries": 1
 *   }
 *
 * Response (success):
 *   { "success": true, "data": {...}, "raw_response": "...", "duration_ms": 1234 }
 */
app.post('/ask-structured', async (req, res) => {
  const {
    prompt,
    callId,
    devicePrompt,
    schema = {},
    includeVoiceContext = false,
    maxRetries = 1,
    model: requestModel,
  } = req.body || {};

  const timestamp = new Date().toISOString();
  const model = resolveClaudeModel(requestModel);

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing prompt in request body' });
  }

  const queryContext = buildQueryContext({
    queryType: schema.queryType,
    requiredFields: schema.requiredFields,
    fieldGuidance: schema.fieldGuidance,
    allowExtraFields: schema.allowExtraFields !== false,
    example: schema.example,
  });

  let fullPrompt = buildStructuredPrompt({
    devicePrompt,
    queryContext: (includeVoiceContext ? VOICE_CONTEXT : '') + queryContext,
    userPrompt: prompt,
  });

  console.log(`[${timestamp}] STRUCTURED QUERY: "${String(prompt).substring(0, 100)}..."`);
  console.log(`[${timestamp}] MODEL: ${model || 'default (Claude Code / OmniRoute)'}`);
  console.log(`[${timestamp}] SESSION: callId=${callId || 'none'}, existing=${callId ? (structuredSessions.has(callId) ? 'yes' : 'no') : 'none'}`);

  try {
    let lastRaw = '';
    let lastError = 'Unknown error';
    let totalDuration = 0;
    const retries = Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 0;
    let attemptsMade = 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      attemptsMade = attempt + 1;
      const { code, stdout, stderr, duration_ms } = await runClaudeOnce({ fullPrompt, callId, timestamp, model });
      totalDuration += duration_ms;

      if (code !== 0) {
        lastError = `Claude CLI failed: ${stderr}`;
        lastRaw = String(stdout || '').trim();
        return res.status(502).json({
          success: false,
          error: lastError,
          raw_response: lastRaw,
          duration_ms: totalDuration,
          attempts: attemptsMade,
        });
      }

      const { response, sessionId } = parseClaudeStdout(stdout);
      lastRaw = response;

      if (sessionId && callId) structuredSessions.set(callId, sessionId);

      const parsed = tryParseJsonFromText(response);
      if (!parsed.ok) {
        lastError = parsed.error || 'Failed to parse JSON';
      } else {
        const validation = validateRequiredFields(parsed.data, schema.requiredFields);
        if (validation.ok) {
          return res.json({
            success: true,
            data: parsed.data,
            json_text: parsed.jsonText,
            raw_response: response,
            duration_ms: totalDuration,
            attempts: attemptsMade,
          });
        }
        lastError = validation.error || 'Validation failed';
      }

      if (attempt >= retries) break;

      // Retry once with a repair prompt that forces "JSON only" formatting.
      const repairPrompt = buildRepairPrompt({
        queryType: schema.queryType,
        requiredFields: schema.requiredFields,
        fieldGuidance: schema.fieldGuidance,
        allowExtraFields: schema.allowExtraFields !== false,
        originalUserPrompt: prompt,
        invalidAssistantOutput: lastRaw,
        example: schema.example,
      });

      fullPrompt = buildStructuredPrompt({
        devicePrompt,
        queryContext: includeVoiceContext ? VOICE_CONTEXT : '',
        userPrompt: repairPrompt,
      });
    }

    return res.status(422).json({
      success: false,
      error: lastError,
      raw_response: lastRaw,
      duration_ms: totalDuration,
      attempts: attemptsMade,
    });
  } catch (error) {
    console.error(`[${timestamp}] ERROR:`, error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /end-session
 *
 * Clean up session when a call ends
 *
 * Request body:
 *   { "callId": "call-uuid" }
 */
app.post('/end-session', (req, res) => {
  const { callId } = req.body;
  const timestamp = new Date().toISOString();

  if (callId && callSessions.has(callId)) {
    callSessions.get(callId).end();
    callSessions.delete(callId);
    console.log(`[${timestamp}] SDK SESSION ENDED: ${callId}`);
  }

  if (callId && structuredSessions.has(callId)) {
    structuredSessions.delete(callId);
    console.log(`[${timestamp}] STRUCTURED SESSION ENDED: ${callId}`);
  }

  res.json({ success: true });
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'claude-api-server',
    model: CLAUDE_MODEL || 'default',
    proxyAuth: Boolean(claudeEnv.ANTHROPIC_BASE_URL || claudeEnv.CLAUDE_USE_API_KEY),
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /
 * Info endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'Claude HTTP API Server',
    version: '2.0.0',
    endpoints: {
      'POST /ask': 'Send a prompt to Claude (persistent SDK session per callId)',
      'POST /ask-structured': 'Send a prompt and return validated JSON (n8n)',
      'GET /health': 'Health check'
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(64));
  console.log('Claude HTTP API Server');
  console.log('='.repeat(64));
  console.log(`\nListening on: http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log('\nReady to receive Claude queries from voice interface.\n');
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down, ending active sessions...');
  for (const session of callSessions.values()) {
    try { session.end(); } catch { /* best effort */ }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
