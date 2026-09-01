#!/usr/bin/env node
// Post-install: installs host-side subpackage dependencies, then prints
// next-steps. Never fails the parent install (package.json calls this with
// `|| true`) - a failed subpackage install here just means `claude-phone
// start`/`claude-phone doctor` will report it later with the exact fix.
//
// claude-api-server and mcp-server run directly on the host (not in Docker,
// unlike voice-app), so npm doesn't install their deps automatically - `npm
// install -g` only installs the top-level package's own dependencies.
// Without this, users hit "Dependencies not installed" only when they later
// run `claude-phone start`, despite the message below promising zero manual
// steps.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');

const HOST_SUBPACKAGES = ['claude-api-server', 'mcp-server'];

for (const dir of HOST_SUBPACKAGES) {
  const dirPath = path.join(packageRoot, dir);
  const nodeModulesPath = path.join(dirPath, 'node_modules');

  if (!existsSync(path.join(dirPath, 'package.json'))) continue;
  if (existsSync(nodeModulesPath)) continue;

  try {
    console.log(`Installing dependencies for ${dir}...`);
    // npm resolves to npm.cmd (a shell shim) on Windows, so it needs
    // shell:true there to run at all. Node warns when shell:true is combined
    // with an args array (each element gets shell-interpolated); passing a
    // single fixed command string instead avoids that, and there is no user
    // input in this string to make interpolation a real risk.
    execFileSync('npm install --omit=dev', {
      cwd: dirPath,
      stdio: 'inherit',
      shell: true
    });
  } catch (error) {
    console.log(`\x1b[33mWarning: could not install ${dir} dependencies automatically.\x1b[0m`);
    console.log(`  Run manually: cd ${dirPath} && npm install\n`);
  }
}

console.log(`
\x1b[36m claude-phone-local installed \x1b[0m

Next steps:
  1. claude-phone setup     # answers 3CX + local STT/TTS questions
  2. claude-phone doctor    # checks Docker, Claude CLI, ports
  3. claude-phone start     # builds + launches everything

Setup also registers the MCP server, so Claude Code can call YOU:
  "call me when the build finishes"
(re-run later with: claude-phone mcp install)

Needs on this machine: Docker (Desktop or Engine) and Claude Code CLI
already logged in. Speech models and voices download automatically on
first run - no manual steps. See README-LOCAL-MODE.md for Windows/3CX.
`);
