/**
 * src/controllers/templateController.js — HTTP handlers for template management
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const config           = require('../config/config');
const templateService  = require('../services/templateService');
const pdfService       = require('../services/pdfService');
const logger           = require('../utils/logger');

// ── GET /api/templates ─────────────────────────────────────────────────────
function listTemplates(_req, res) {
  const templates = templateService.listTemplates();
  res.json({ templates });
}

// ── GET /api/templates/:id ─────────────────────────────────────────────────
async function getTemplate(req, res, next) {
  try {
    const template = templateService.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // Refresh field list (with positions) from the actual PDF
    const pdfPath = path.join(config.templatesDir, template.filename);
    const fields  = await pdfService.getFieldsWithPositions(pdfPath);

    // Merge stored mapping back in
    const enriched = fields.map(f => ({
      ...f,
      mappedTo: template.mapping[f.name] || '',
    }));

    res.json({ ...template, fields: enriched });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/templates/upload ─────────────────────────────────────────────
async function uploadTemplate(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file provided' });

    const { originalname, filename } = req.file;
    const displayName = (req.body.name || path.basename(originalname, '.pdf')).trim();

    // Detect fields from the PDF
    const pdfPath = path.join(config.templatesDir, filename);
    const fields  = await pdfService.getFieldsWithPositions(pdfPath);

    if (fields.length === 0) {
      logger.warn(`Uploaded PDF has no AcroForm fields: ${originalname}`);
    }

    const template = templateService.createTemplate({
      name:     displayName,
      filename,
      fields,
    });

    logger.info(`Template uploaded: ${displayName}`, { fields: fields.length });
    res.status(201).json({ template, fieldCount: fields.length });

  } catch (err) {
    next(err);
  }
}

// ── PUT /api/templates/:id/mapping ─────────────────────────────────────────
function updateMapping(req, res) {
  const { mapping } = req.body;

  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return res.status(400).json({ error: '"mapping" must be an object' });
  }

  const updated = templateService.updateMapping(req.params.id, mapping);
  if (!updated) return res.status(404).json({ error: 'Template not found' });

  res.json({ template: updated });
}

// ── PUT /api/templates/:id/rename ──────────────────────────────────────────
function renameTemplate(req, res) {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '"name" is required' });

  const updated = templateService.renameTemplate(req.params.id, name.trim());
  if (!updated) return res.status(404).json({ error: 'Template not found' });

  res.json({ template: updated });
}

// ── DELETE /api/templates/:id ──────────────────────────────────────────────
function deleteTemplate(req, res) {
  const deleted = templateService.deleteTemplate(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Template not found' });
  res.json({ success: true });
}

// ── GET /api/templates/:id/pdf ─────────────────────────────────────────────
// Serve the raw PDF bytes for rendering in the browser via PDF.js
function servePdf(req, res, next) {
  try {
    const template = templateService.getTemplate(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const pdfPath = path.join(config.templatesDir, template.filename);
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${template.filename}"`);
    // Allow PDF.js running on the same origin to load this
    res.setHeader('Access-Control-Allow-Origin', '*');

    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listTemplates,
  getTemplate,
  uploadTemplate,
  updateMapping,
  renameTemplate,
  deleteTemplate,
  servePdf,
};
