/**
 * server.js — Entry point
 *
 * Loads environment variables, then starts the Express server.
 * Keeping this file minimal makes it easier to swap transport layers
 * (e.g. Electron's embedded server) without touching application logic.
 */

'use strict';

require('dotenv').config();

const app     = require('./src/app');
const config  = require('./src/config/config');
const logger  = require('./src/utils/logger');
const cleanup = require('./src/utils/fileCleanup');

const PORT = config.port;

const server = app.listen(PORT, () => {
  logger.info(`Bulk PDF Generator running on http://localhost:${PORT} [${config.nodeEnv}]`);
  cleanup.scheduleCleanup();
});

// Graceful shutdown — important for large batch jobs in flight
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down gracefully');
  server.close(() => process.exit(0));
});

module.exports = server; // exported for testing
