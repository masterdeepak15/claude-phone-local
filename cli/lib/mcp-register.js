/**
 * Register the claude-phone MCP server with the Claude Code CLI.
 *
 * Done from `claude-phone setup` (and `claude-phone mcp install`) rather than
 * from npm's postinstall, for two reasons:
 *   - postinstall runs before setup, so the extension to call is not known yet;
 *   - silently editing the user's ~/.claude.json during `npm install` is rude.
 *
 * Everything here is best-effort: a missing `claude` CLI is reported and
 * skipped, never fatal.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the MCP server entry point inside the installed package. */
export function mcpServerPath() {
  return path.resolve(__dirname, '..', '..', 'mcp-server', 'index.js');
}

function claudeAvailable() {
  try {
    execFileSync('claude', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function alreadyRegistered() {
  try {
    const out = execFileSync('claude', ['mcp', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /^\s*claude-phone:/m.test(out);
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} [opts.defaultTo]  Extension/number Claude should ring.
 * @param {number} [opts.httpPort]   voice-app HTTP port.
 * @param {boolean} [opts.force]     Re-register even if already present.
 * @returns {{ok: boolean, reason?: string}}
 */
export function registerMcpServer({ defaultTo, httpPort = 3000, force = false } = {}) {
  const serverPath = mcpServerPath();

  if (!existsSync(serverPath)) {
    return { ok: false, reason: `MCP server not found at ${serverPath}` };
  }
  if (!claudeAvailable()) {
    return { ok: false, reason: 'Claude Code CLI not found on PATH' };
  }

  if (alreadyRegistered()) {
    if (!force) return { ok: true, reason: 'already registered' };
    try {
      execFileSync('claude', ['mcp', 'remove', 'claude-phone', '--scope', 'user'], { stdio: 'ignore' });
    } catch {
      // Not fatal - add may still succeed, or report a clearer error.
    }
  }

  const args = [
    'mcp', 'add', 'claude-phone',
    '--scope', 'user',
    '--env', `VOICE_APP_URL=http://127.0.0.1:${httpPort}`,
  ];
  if (defaultTo) args.push('--env', `PHONE_DEFAULT_TO=${defaultTo}`);
  args.push('--', 'node', serverPath);

  try {
    execFileSync('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
    return { ok: false, reason: detail };
  }
}

/** Register and print a short human-readable result. Never throws. */
export function registerMcpServerWithOutput(opts = {}) {
  const result = registerMcpServer(opts);

  if (result.ok && result.reason === 'already registered') {
    console.log(chalk.gray('  MCP server already registered (use --force to update)'));
  } else if (result.ok) {
    console.log(chalk.green('  MCP server registered as "claude-phone"'));
    if (opts.defaultTo) {
      console.log(chalk.gray(`  Claude will ring ${opts.defaultTo} by default`));
    }
    console.log(chalk.yellow('  Restart Claude Code, then try: "call me when the build finishes"'));
  } else {
    console.log(chalk.yellow(`  Skipped MCP registration: ${result.reason}`));
    console.log(chalk.gray('  Register later with: claude-phone mcp install'));
  }

  return result;
}
