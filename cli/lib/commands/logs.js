import chalk from 'chalk';
import { spawn } from 'child_process';
import { loadConfig, configExists, getDockerComposePath, getPidPath, getConfigDir } from '../config.js';
import fs from 'fs';
import path from 'path';

/**
 * Logs command - Tail service logs
 * @param {string} [service] - Optional service name (voice-app or api-server)
 * @returns {Promise<void>}
 */
export async function logsCommand(service = null) {
  if (!configExists()) {
    console.log(chalk.red('\n✗ Not configured'));
    console.log(chalk.gray('  Run "claude-phone setup" first\n'));
    process.exit(1);
  }

  const config = await loadConfig();
  const dockerComposePath = getDockerComposePath();

  // Validate service argument
  const validServices = ['voice-app', 'api-server'];
  if (service && !validServices.includes(service)) {
    console.log(chalk.red(`\n✗ Invalid service: ${service}`));
    console.log(chalk.gray('  Valid services: voice-app, api-server'));
    console.log(chalk.gray('  Or omit service to tail all logs\n'));
    process.exit(1);
  }

  // Header
  if (service) {
    console.log(chalk.bold.cyan(`\n📋 Tailing logs for ${service}...\n`));
  } else {
    console.log(chalk.bold.cyan('\n📋 Tailing all service logs...\n'));
  }

  // Handle different service options
  if (!service || service === 'voice-app') {
    // Docker container logs
    if (!fs.existsSync(dockerComposePath)) {
      console.log(chalk.yellow('⚠ Docker containers not configured'));
      console.log(chalk.gray('  Run "claude-phone start" first\n'));
      if (service === 'voice-app') {
        process.exit(1);
      }
    } else if (!service) {
      // Both services - interleave logs
      tailBothServices(dockerComposePath, config);
      return;
    } else {
      // Just voice-app
      tailDockerLogs(dockerComposePath);
      return;
    }
  }

  if (!service || service === 'api-server') {
    // API server logs
    const pidPath = getPidPath();
    if (!fs.existsSync(pidPath)) {
      console.log(chalk.yellow('⚠ Claude API server not running'));
      console.log(chalk.gray('  Run "claude-phone start" first\n'));
      if (service === 'api-server') {
        process.exit(1);
      }
    } else if (service === 'api-server') {
      tailAPIServerLogs(config);
      return;
    }
  }
}

/**
 * Tail Docker container logs
 * @param {string} dockerComposePath - Path to docker-compose.yml
 */
function tailDockerLogs(dockerComposePath) {
  const child = spawn('docker', [
    'compose',
    '-f',
    dockerComposePath,
    'logs',
    '-f',
    '--tail=50'
  ], {
    stdio: 'inherit'
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    child.kill('SIGTERM');
    console.log(chalk.gray('\n\nStopped tailing logs.\n'));
    process.exit(0);
  });

  child.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.log(chalk.red(`\n✗ Docker logs failed with exit code ${code}\n`));
      process.exit(code);
    }
  });
}

/**
 * Tail API server logs
 * @param {object} _config - Configuration object (unused; log path is fixed)
 */
function tailAPIServerLogs(_config) {
  const logPath = path.join(getConfigDir(), 'claude-api-server.log');

  if (!fs.existsSync(logPath)) {
    console.log(chalk.yellow('⚠ No log file yet - the API server has not written any output'));
    console.log(chalk.gray(`  Expected at: ${logPath}\n`));
    process.exit(1);
  }

  console.log(chalk.gray(`Watching ${logPath}\n`));

  // Print the last ~50 lines, then follow new writes. No native `tail -f` on
  // Windows, so poll the file size and read only the appended bytes.
  const fullContent = fs.readFileSync(logPath, 'utf8');
  const lines = fullContent.split('\n');
  const tailLines = lines.slice(Math.max(0, lines.length - 50));
  process.stdout.write(tailLines.join('\n'));

  let position = fs.statSync(logPath).size;

  const poll = setInterval(() => {
    try {
      const { size } = fs.statSync(logPath);
      if (size < position) {
        // Log file was rotated/truncated (e.g. by a restart) - start over.
        position = 0;
      }
      if (size > position) {
        const fd = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(size - position);
        fs.readSync(fd, buffer, 0, buffer.length, position);
        fs.closeSync(fd);
        process.stdout.write(buffer.toString('utf8'));
        position = size;
      }
    } catch (err) {
      console.log(chalk.red(`\n✗ Lost access to log file: ${err.message}\n`));
      clearInterval(poll);
      process.exit(1);
    }
  }, 1000);

  process.on('SIGINT', () => {
    clearInterval(poll);
    console.log(chalk.gray('\n\nStopped tailing logs.\n'));
    process.exit(0);
  });
}

/**
 * Tail both services with interleaved output
 * @param {string} dockerComposePath - Path to docker-compose.yml
 * @param {object} _config - Configuration object (unused)
 */
function tailBothServices(dockerComposePath, _config) {
  console.log(chalk.gray('Showing Docker container logs. Run "claude-phone logs api-server" separately for the host-side API server log.\n'));

  const child = spawn('docker', [
    'compose',
    '-f',
    dockerComposePath,
    'logs',
    '-f',
    '--tail=50'
  ], {
    stdio: 'inherit'
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    child.kill('SIGTERM');
    console.log(chalk.gray('\n\nStopped tailing logs.\n'));
    process.exit(0);
  });

  child.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.log(chalk.red(`\n✗ Docker logs failed with exit code ${code}\n`));
      process.exit(code);
    }
  });
}
