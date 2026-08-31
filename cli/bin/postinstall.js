#!/usr/bin/env node
// Friendly next-steps message after `npm install -g claude-phone-local`.
// Never fails the install (package.json calls this with `|| true`).

console.log(`
\x1b[36m claude-phone-local installed \x1b[0m

Next steps:
  1. claude-phone setup     # answers 3CX + local STT/TTS questions
  2. claude-phone doctor    # checks Docker, Claude CLI, ports
  3. claude-phone start     # builds + launches everything

Needs on this machine: Docker (Desktop or Engine) and Claude Code CLI
already logged in. See README-LOCAL-MODE.md for the full Windows/WSL2
walkthrough, including a Piper voice download step.
`);
