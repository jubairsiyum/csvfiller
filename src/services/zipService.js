/**
 * src/services/zipService.js — ZIP streaming service
 *
 * Uses archiver to compress a batch output directory on-the-fly and pipe
 * the resulting bytes directly into an HTTP response stream — no temporary
 * .zip file is written to disk.
 *
 * The caller passes the Express `res` object; this service sets appropriate
 * headers and finishes the stream.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');
const logger   = require('../utils/logger');

/**
 * Stream a ZIP of all PDFs in batchDir directly to an HTTP response.
 *
 * @param {string}                batchDir  — Absolute path to batch output dir
 * @param {string}                batchId   — Used as the ZIP filename
 * @param {import('express').Response} res  — Express response object
 * @returns {Promise<void>}  Resolves when the stream finishes or rejects on error
 */
async function streamBatchZip(batchDir, batchId, res) {
  // Verify the directory exists before touching the response
  if (!fs.existsSync(batchDir)) {
    const err = new Error(`Batch directory not found: ${batchDir}`);
    err.statusCode = 404;
    throw err;
  }

  const zipName = `batch_${batchId}.zip`;

  // Set headers before piping — they cannot be changed after streaming starts
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', {
      zlib: { level: 6 }, // Balanced compression; 9 is max but slower
    });

    // Pipe archive data to the response
    archive.pipe(res);

    // Add every file in batchDir (non-recursive — PDFs are flat)
    archive.directory(batchDir, false);

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        logger.warn('Archiver warning (ENOENT)', { message: err.message });
      } else {
        reject(err);
      }
    });

    archive.on('error', (err) => {
      logger.error('Archiver error', { message: err.message });
      reject(err);
    });

    archive.on('finish', () => {
      logger.info(`ZIP streamed for batch ${batchId}`, {
        bytes: archive.pointer(),
      });
      resolve();
    });

    res.on('close', () => {
      // Client disconnected early — resolve silently
      resolve();
    });

    // Finalise — triggers the actual compression
    archive.finalize();
  });
}

/**
 * Count the number of PDF files in a batch directory.
 * @param {string} batchDir
 * @returns {Promise<number>}
 */
async function countFiles(batchDir) {
  try {
    const entries = await fs.promises.readdir(batchDir);
    return entries.filter(f => f.endsWith('.pdf')).length;
  } catch {
    return 0;
  }
}

module.exports = { streamBatchZip, countFiles };
