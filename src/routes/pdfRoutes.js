/**
 * src/routes/pdfRoutes.js — Express router
 *
 * Wires HTTP methods + paths to controller functions.
 * Multer upload middleware is configured here so it stays close to the
 * route it guards, and controllers remain testable without file I/O.
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const config     = require('../config/config');
const controller = require('../controllers/pdfController');
const logger     = require('../utils/logger');

const router = express.Router();

// ── Multer setup ───────────────────────────────────────────────────────────

// Ensure upload directory exists at startup
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, config.uploadDir);
  },
  filename(_req, file, cb) {
    // prefix with uuid to avoid name collisions
    const ext  = path.extname(file.originalname).toLowerCase();
    const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${uuidv4()}_${safe}${ext}`);
  },
});

function csvFilter(_req, file, cb) {
  const ext  = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype;

  const allowed = [
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'text/plain',      // some browsers send CSV as text/plain
  ];

  if (ext === '.csv' || allowed.includes(mime)) {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only .csv files are accepted'), { statusCode: 400 }), false);
  }
}

const upload = multer({
  storage,
  fileFilter: csvFilter,
  limits: {
    fileSize: config.maxFileSize,
    files:    1,
  },
});

// Multer error → JSON (instead of Express default HTML)
function handleMulterError(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    logger.warn('Multer error', { code: err.code, message: err.message });
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large. Maximum size is ${config.maxFileSize} bytes`
      : err.message;
    return res.status(400).json({ error: msg });
  }
  next(err);
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Accepts a multipart/form-data request with field name "csv".
 */
router.post(
  '/upload',
  upload.single('csv'),
  handleMulterError,
  controller.uploadCSV
);

/**
 * POST /api/generate
 * Body: { batchId: string, fieldMapping: object }
 */
router.post('/generate', controller.generatePDFs);

/**
 * GET /api/download/:batchId
 * Streams a ZIP archive of all PDFs for the batch.
 */
router.get('/download/:batchId', controller.downloadBatch);

/**
 * GET /api/progress/:batchId
 * Returns JSON with current generation progress.
 */
router.get('/progress/:batchId', controller.getBatchProgress);

/**
 * GET /api/fields
 * Returns all AcroForm field names from the PDF template.
 */
router.get('/fields', controller.getTemplateFields);

module.exports = router;
