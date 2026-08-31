/**
 * Simple logger module
 * Provides consistent logging format with timestamps
 */

function formatMessage(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length > 0 ? ' ' + JSON.stringify(data) : '';
  return `[${timestamp}] ${level.toUpperCase()} ${message}${dataStr}`;
}

function info(message, data) {
  console.log(formatMessage('info', message, data));
}

function warn(message, data) {
  console.warn(formatMessage('warn', message, data));
}

function error(message, data) {
  console.error(formatMessage('error', message, data));
}

function debug(message, data) {
  if (process.env.DEBUG) {
    console.log(formatMessage('debug', message, data));
  }
}

module.exports = {
  info,
  warn,
  error,
  debug
};
