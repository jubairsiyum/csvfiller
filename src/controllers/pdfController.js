/**
 * src/controllers/pdfController.js — Route handler logic
 *
 * Each exported function corresponds to one API endpoint.
 * Controllers are deliberately thin: they validate HTTP-layer concerns
 * (file presence, body shape) and delegate all business logic to services.
 *
 * This separation means services can be called from test harnesses,
 * CLI scripts, or Electron IPC handlers without touching Express.
 */

'use strict';

const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config     = require('../config/config');
const csvService = require('../services/csvService');
const pdfService = require('../services/pdfService');
const zipService = require('../services/zipService');
const logger     = require('../utils/logger');

// In-memory progress map — replace with Redis/BullMQ for multi-process setups
const progressMap = new Map(); // batchId → { done, total, status }

// ── POST /api/upload ───────────────────────────────────────────────────────
/**
 * Accept a CSV upload, validate it, return a batchId.
 */
async function uploadCSV(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file provided' });
    }

    const { originalname, path: filePath, size } = req.file;

    // Double-check MIME / extension after multer's filter
    if (!originalname.toLowerCase().endsWith('.csv')) {
      return res.status(400).json({ error: 'Only .csv files are accepted' });
    }

    const batchId = uuidv4();

    // Quick parse just to validate structure — no mapping yet
    const { rows, columns } = await csvService.parseCSV(filePath);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'CSV file contains no data rows' });
    }

    // Store metadata so /generate can retrieve the file by batchId
    progressMap.set(batchId, {
      csvPath:  filePath,
      columns,
      rowCount: rows.length,
      status:   'uploaded',
      done:     0,
      total:    rows.length,
    });

    logger.info(`CSV uploaded: batch=${batchId}, rows=${rows.length}`, { file: originalname });

    return res.json({
      batchId,
      rowCount: rows.length,
      columns,
      fileSizeBytes: size,
    });

  } catch (err) {
    next(err);
  }
}

// ── POST /api/generate ─────────────────────────────────────────────────────
/**
 * Parse the CSV, fill PDFs, store in output/{batchId}/.
 */
async function generatePDFs(req, res, next) {
  try {
    const { batchId, fieldMapping } = req.body;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!batchId) {
      return res.status(400).json({ error: '"batchId" is required' });
    }
    if (!fieldMapping || typeof fieldMapping !== 'object' || Array.isArray(fieldMapping)) {
      return res.status(400).json({ error: '"fieldMapping" must be a non-empty object' });
    }
    if (Object.keys(fieldMapping).length === 0) {
      return res.status(400).json({ error: '"fieldMapping" must contain at least one mapping' });
    }

    const meta = progressMap.get(batchId);
    if (!meta) {
      return res.status(404).json({ error: `Batch "${batchId}" not found. Upload a CSV first.` });
    }
    if (meta.status === 'processing') {
      return res.status(409).json({ error: 'Batch is already being processed' });
    }

    // ── Validate mapping against CSV columns ────────────────────────────────
    const { warnings: mappingWarnings } = csvService.validateFieldMapping(
      fieldMapping,
      meta.columns
    );
    if (mappingWarnings.length) {
      logger.warn('Field mapping warnings', { batchId, warnings: mappingWarnings });
    }

    // ── Re-parse CSV (stream) ───────────────────────────────────────────────
    const { rows } = await csvService.parseCSV(meta.csvPath);

    const batchDir = path.join(config.outputDir, batchId);

    // Mark as processing
    meta.status = 'processing';
    meta.done   = 0;
    meta.total  = rows.length;
    progressMap.set(batchId, meta);

    // Progress callback
    const onProgress = (done, total) => {
      meta.done = done;
      progressMap.set(batchId, meta);
      logger.debug(`Progress: ${done}/${total}`, { batchId });
    };

    // ── Process ─────────────────────────────────────────────────────────────
    const summary = await pdfService.processBatch(rows, fieldMapping, batchDir, onProgress);

    meta.status  = 'complete';
    meta.summary = summary;
    progressMap.set(batchId, meta);

    return res.json({
      batchId,
      ...summary,
      mappingWarnings,
      downloadUrl: `/api/download/${batchId}`,
    });

  } catch (err) {
    // Mark batch as failed so client can retry
    if (req.body?.batchId) {
      const meta = progressMap.get(req.body.batchId);
      if (meta) {
        meta.status = 'failed';
        progressMap.set(req.body.batchId, meta);
      }
    }
    next(err);
  }
}

// ── GET /api/download/:batchId ─────────────────────────────────────────────
/**
 * Stream a ZIP of all generated PDFs to the client.
 */
async function downloadBatch(req, res, next) {
  try {
    const { batchId } = req.params;

    // Basic path-traversal guard
    if (!/^[0-9a-f-]{36}$/.test(batchId)) {
      return res.status(400).json({ error: 'Invalid batchId format' });
    }

    const batchDir = path.join(config.outputDir, batchId);
    await zipService.streamBatchZip(batchDir, batchId, res);

  } catch (err) {
    next(err);
  }
}

// ── GET /api/progress/:batchId ─────────────────────────────────────────────
/**
 * Return current processing progress for a batch.
 * Bonus: clients can poll this for a progress bar.
 */
function getBatchProgress(req, res) {
  const { batchId } = req.params;
  const meta = progressMap.get(batchId);

  if (!meta) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  const pct = meta.total ? Math.round((meta.done / meta.total) * 100) : 0;

  return res.json({
    batchId,
    status:  meta.status,
    done:    meta.done,
    total:   meta.total,
    percent: pct,
    summary: meta.summary || null,
  });
}

// ── GET /api/fields ────────────────────────────────────────────────────────
/**
 * Return all AcroForm field names found in the PDF template.
 * Bonus: field auto-detection for the UI.
 */
async function getTemplateFields(req, res, next) {
  try {
    const fields = await pdfService.getTemplateFields();
    return res.json({ fields });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadCSV,
  generatePDFs,
  downloadBatch,
  getBatchProgress,
  getTemplateFields,
};
