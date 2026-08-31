#!/usr/bin/env node
/**
 * prepublishOnly guard.
 *
 * `npm publish` is irreversible - a version number can be deprecated but its
 * contents stay downloadable. This aborts the publish if the tarball would
 * contain anything secret or absurdly large, rather than trusting .npmignore
 * to have been maintained correctly.
 */
import { execSync } from 'node:child_process';

const FORBIDDEN = [
  { pattern: /(^|\/)\.env$/,            reason: 'environment file with credentials' },
  { pattern: /devices\.json$/,          reason: 'SIP credentials' },
  { pattern: /\.onnx$/,                 reason: 'voice model (downloaded at runtime)' },
  { pattern: /(^|\/)data\//,            reason: 'runtime data directory' },
  { pattern: /\.(pem|key|p12|pfx)$/,    reason: 'private key' },
];

const MAX_TARBALL_MB = 25;

let files, sizeMB;
try {
  const out = execSync('npm pack --dry-run --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const meta = JSON.parse(out)[0];
  files = meta.files.map((f) => f.path);
  sizeMB = meta.unpackedSize / (1024 * 1024);
} catch (err) {
  console.error('publish-safety: could not inspect the tarball -', err.message);
  process.exit(1);
}

const offenders = [];
for (const file of files) {
  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(file)) offenders.push(`  ${file}  <- ${reason}`);
  }
}

if (offenders.length) {
  console.error('\npublish BLOCKED - these files must not be published:\n');
  console.error(offenders.join('\n'));
  console.error('\nAdd them to .npmignore, then try again.\n');
  process.exit(1);
}

if (sizeMB > MAX_TARBALL_MB) {
  console.error(`\npublish BLOCKED - unpacked size ${sizeMB.toFixed(1)} MB exceeds ${MAX_TARBALL_MB} MB.`);
  console.error('Models are meant to download at runtime, not ship in the package.\n');
  process.exit(1);
}

console.log(`publish-safety OK - ${files.length} files, ${sizeMB.toFixed(1)} MB unpacked`);
