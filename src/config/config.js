/**
 * src/config/config.js — Centralised configuration
 *
 * All env variables are read once here and exported as a plain object.
 * Other modules import this instead of calling process.env directly so
 * that defaults, type coercion, and validation happen in one place.
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseBytes(value) {
  // Accepts "5MB", "5mb", or raw number string
  if (!value) return 5 * 1024 * 1024;
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*(mb|kb|b)?$/i);
  if (!match) return parseInt(value, 10);
  const n = parseFloat(match[1]);
  switch ((match[2] || 'b').toLowerCase()) {
    case 'mb': return Math.round(n * 1024 * 1024);
    case 'kb': return Math.round(n * 1024);
    default:   return Math.round(n);
  }
}

const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  // Directories (absolute paths)
  uploadDir:    path.join(ROOT, process.env.UPLOAD_DIR    || 'uploads'),
  outputDir:    path.join(ROOT, process.env.OUTPUT_DIR    || 'output'),
  templatesDir: path.join(ROOT, process.env.TEMPLATES_DIR || 'templates'),

  // Upload limits
  maxFileSize: parseBytes(process.env.MAX_FILE_SIZE || '5MB'),

  // File cleanup
  cleanupAfterMinutes: parseInt(process.env.CLEANUP_AFTER_MINUTES, 10) || 60,

  // PDF template filename
  pdfTemplateName: process.env.PDF_TEMPLATE || 'form.pdf',
};

module.exports = config;
