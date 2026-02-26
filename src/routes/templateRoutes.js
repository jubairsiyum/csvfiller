/**
 * src/routes/templateRoutes.js — Template management router
 *
 * PDF uploads go to the templates/ directory (not uploads/).
 * Multer is configured to preserve the original filename with a uuid prefix.
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const config     = require('../config/config');
const controller = require('../controllers/templateController');

const router = express.Router();

// ── Multer for PDF template uploads ────────────────────────────────────────
fs.mkdirSync(config.templatesDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.templatesDir),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const safe = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    cb(null, `${uuidv4()}_${safe}${ext}`);
  },
});

function pdfFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.pdf' || file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(Object.assign(new Error('Only .pdf files are accepted'), { statusCode: 400 }), false);
  }
}

const upload = multer({
  storage,
  fileFilter: pdfFilter,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // 50 MB for templates
});

function handleMulterError(err, _req, res, next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.get   ('/',              controller.listTemplates);
router.post  ('/upload',        upload.single('pdf'), handleMulterError, controller.uploadTemplate);
router.get   ('/:id',           controller.getTemplate);
router.get   ('/:id/pdf',       controller.servePdf);
router.put   ('/:id/mapping',   controller.updateMapping);
router.put   ('/:id/rename',    controller.renameTemplate);
router.delete('/:id',           controller.deleteTemplate);

module.exports = router;
