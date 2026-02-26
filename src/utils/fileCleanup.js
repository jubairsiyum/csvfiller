/**
 * src/utils/fileCleanup.js — Scheduled cleanup of old batch files
 *
 * Deletes upload files and output batch directories that are older than
 * `config.cleanupAfterMinutes`.  Called on a setInterval in server.js
 * (or manually before graceful shutdown).
 *
 * Why here and not in a service?
 *   This is infrastructure plumbing — not business logic.  Keeping it in
 *   utils prevents cluttering the service layer.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const config = require('../config/config');
const logger = require('./logger');

/**
 * Remove a directory tree (equivalent to rm -rf).
 * @param {string} dirPath
 */
async function removeDir(dirPath) {
  await fs.promises.rm(dirPath, { recursive: true, force: true });
}

/**
 * Delete files/directories in a folder whose mtime is older than maxAgeMs.
 *
 * @param {string} folder
 * @param {number} maxAgeMs
 */
async function cleanOlderThan(folder, maxAgeMs) {
  if (!fs.existsSync(folder)) return;

  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const now     = Date.now();
  let   removed = 0;

  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);
    try {
      const { mtimeMs } = await fs.promises.stat(fullPath);
      if (now - mtimeMs > maxAgeMs) {
        if (entry.isDirectory()) {
          await removeDir(fullPath);
        } else {
          await fs.promises.unlink(fullPath);
        }
        removed++;
        logger.debug(`Cleaned up: ${fullPath}`);
      }
    } catch (err) {
      logger.warn(`Cleanup skipped ${fullPath}`, { message: err.message });
    }
  }

  if (removed) {
    logger.info(`Cleanup: removed ${removed} item(s) from ${path.basename(folder)}`);
  }
}

/**
 * Run cleanup across both upload and output directories.
 */
async function runCleanup() {
  if (!config.cleanupAfterMinutes) return; // 0 = disabled

  const maxAgeMs = config.cleanupAfterMinutes * 60 * 1000;
  logger.debug('Running scheduled file cleanup...');

  await Promise.all([
    cleanOlderThan(config.uploadDir, maxAgeMs),
    cleanOlderThan(config.outputDir, maxAgeMs),
  ]);
}

/**
 * Delete a specific batch's upload file and output directory immediately.
 *
 * @param {string} batchId
 * @param {string} csvFilePath — Absolute path to the uploaded CSV
 */
async function cleanBatch(batchId, csvFilePath) {
  const batchDir = path.join(config.outputDir, batchId);
  await Promise.allSettled([
    removeDir(batchDir),
    fs.promises.unlink(csvFilePath).catch(() => {}),
  ]);
  logger.info(`Batch ${batchId} files deleted`);
}

/**
 * Schedule automatic cleanup based on config.  Returns the timer so the
 * caller can clearInterval on shutdown.
 *
 * @returns {NodeJS.Timeout|null}
 */
function scheduleCleanup() {
  if (!config.cleanupAfterMinutes) {
    logger.info('File cleanup disabled (CLEANUP_AFTER_MINUTES=0)');
    return null;
  }

  // Check every half of the max age (but at least every 5 minutes)
  const intervalMs = Math.max(config.cleanupAfterMinutes * 30 * 1000, 5 * 60 * 1000);

  const timer = setInterval(() => {
    runCleanup().catch(err =>
      logger.error('Cleanup task failed', { message: err.message })
    );
  }, intervalMs);

  timer.unref(); // Don't prevent process exit

  logger.info(`File cleanup scheduled every ${intervalMs / 60000} min`);
  return timer;
}

module.exports = { runCleanup, cleanBatch, scheduleCleanup };
