/**
 * src/utils/logger.js — Winston-based structured logger
 *
 * Outputs JSON in production (easy to ingest in log aggregators) and
 * pretty-printed coloured text in development.
 */

'use strict';

const { createLogger, format, transports } = require('winston');

const { combine, timestamp, printf, colorize, errors } = format;

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// Human-readable format for dev terminals
const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    let line = `${ts} [${level}] ${message}`;
    if (Object.keys(meta).length) line += ' ' + JSON.stringify(meta);
    if (stack) line += '\n' + stack;
    return line;
  })
);

// Structured JSON for production / log pipelines
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  format.json()
);

const logger = createLogger({
  level: isDev ? 'debug' : 'info',
  format: isDev ? devFormat : prodFormat,
  transports: [
    new transports.Console(),
  ],
  // Do not crash the process on unhandled exceptions — log them instead
  exceptionHandlers: [new transports.Console()],
  rejectionHandlers: [new transports.Console()],
});

module.exports = logger;
