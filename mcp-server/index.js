#!/usr/bin/env node
/**
 * claude-phone MCP server.
 *
 * Gives a Claude Code session a phone: it can ring the user mid-task, say why,
 * and (in conversation mode) talk the decision through, then carry on.
 *
 * Wraps the voice-app HTTP API - it does no SIP work of its own.
 *
 *   VOICE_APP_URL   where voice-app listens        (default http://127.0.0.1:3000)
 *   PHONE_DEFAULT_TO   number/extension to ring    (default from .env SIP_EXTENSION)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const VOICE_APP_URL = process.env.VOICE_APP_URL || 'http://127.0.0.1:3000';
const DEFAULT_TO = process.env.PHONE_DEFAULT_TO || '';

async function api(path, options = {}) {
  const res = await fetch(`${VOICE_APP_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  return body;
}

const TOOLS = [
  {
    name: 'call_me',
    description:
      'Ring the user on the phone and speak a message. Use when you need a decision, ' +
      'hit a blocker, or finished something they asked to be told about.\n\n' +
      'RETURNS IMMEDIATELY - it does not wait for the call to finish, so keep working ' +
      'on the task while the phone rings.\n\n' +
      'mode="conversation" keeps the line open so they can answer back and the voice ' +
      'agent talks with them. To hear what they said, call call_status with the ' +
      'returned callId once you reach a point where their answer matters. If they do ' +
      'not pick up or say nothing, the call ends by itself and call_status reports it.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'What to say when they pick up. One or two spoken sentences, no markdown.',
        },
        mode: {
          type: 'string',
          enum: ['announce', 'conversation'],
          description:
            'announce = say it and hang up. conversation = stay on the line so they can reply.',
          default: 'announce',
        },
        to: {
          type: 'string',
          description: 'Number or extension to ring. Defaults to the configured one.',
        },
        context: {
          type: 'string',
          description:
            'Background for the voice agent so it can answer follow-up questions. ' +
            'Never spoken aloud - put the detail here, not in message.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'call_status',
    description:
      'Check a call started with call_me: whether it is still up, and in conversation ' +
      'mode what the user actually said. Returns conversationHistory with each turn. ' +
      'Poll this when you need their answer - do not block waiting for it.',
    inputSchema: {
      type: 'object',
      properties: { callId: { type: 'string', description: 'The callId returned by call_me.' } },
      required: ['callId'],
    },
  },
  {
    name: 'hangup',
    description: 'End a call that is still in progress.',
    inputSchema: {
      type: 'object',
      properties: { callId: { type: 'string' } },
      required: ['callId'],
    },
  },
];

const server = new Server(
  { name: 'claude-phone', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'call_me') {
      const to = args.to || DEFAULT_TO;
      if (!to) throw new Error('No destination: pass "to" or set PHONE_DEFAULT_TO.');

      // The API only accepts 'announce' | 'conversation'. Accept the looser words a
      // model might reach for rather than silently sending an unknown mode, which
      // matches neither branch and leaves the call hanging.
      const raw = (args.mode || 'announce').toLowerCase();
      const mode = ['conversation', 'converse', 'talk', 'discuss'].includes(raw)
        ? 'conversation'
        : 'announce';

      const body = {
        to,
        message: args.message,
        mode,
        ...(args.context ? { context: args.context } : {}),
      };
      const out = await api('/api/outbound-call', { method: 'POST', body: JSON.stringify(body) });
      const callId = out.callId || 'unknown';

      return {
        content: [{
          type: 'text',
          text:
            `Calling ${to} now (callId=${callId}, status=${out.status || 'started'}). ` +
            'This returned immediately - carry on with the task while it rings.' +
            (mode === 'conversation'
              ? `\n\nConversation mode: they can reply. When you need their answer, call ` +
                `call_status with callId=${callId} and read conversationHistory. If they ` +
                'do not answer or stay silent, the call ends on its own.'
              : '\n\nAnnounce mode: it speaks the message and hangs up. No reply is collected.'),
        }],
      };
    }

    if (name === 'call_status') {
      const out = await api(`/api/call/${encodeURIComponent(args.callId)}`);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }

    if (name === 'hangup') {
      const out = await api(`/api/call/${encodeURIComponent(args.callId)}/hangup`, { method: 'POST' });
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    // Surfaced to the model as a failure it can react to, not a crash.
    return { isError: true, content: [{ type: 'text', text: `claude-phone: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
console.error('[claude-phone-mcp] ready, voice-app at ' + VOICE_APP_URL);
