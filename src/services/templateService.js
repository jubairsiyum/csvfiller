/**
 * src/services/templateService.js — Template metadata persistence
 *
 * Templates are stored as a JSON catalogue at templates/metadata.json.
 * Each template record holds:
 *   id, name, filename (relative to templatesDir), fields (array from PDF),
 *   mapping ({ pdfField: csvColumn }), createdAt.
 *
 * Using a flat JSON file keeps the stack dependency-free and is perfectly
 * appropriate for dozens of templates.  Swap to SQLite/Postgres if you
 * ever need concurrent writes from multiple workers.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('../config/config');
const logger = require('../utils/logger');

const CATALOGUE = path.join(config.templatesDir, 'metadata.json');

// ── Internal helpers ───────────────────────────────────────────────────────

function readCatalogue() {
  if (!fs.existsSync(CATALOGUE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  } catch {
    return [];
  }
}

function writeCatalogue(templates) {
  fs.mkdirSync(config.templatesDir, { recursive: true });
  fs.writeFileSync(CATALOGUE, JSON.stringify(templates, null, 2), 'utf8');
}

// ── Public API ─────────────────────────────────────────────────────────────

function listTemplates() {
  return readCatalogue();
}

function getTemplate(id) {
  const all = readCatalogue();
  return all.find(t => t.id === id) || null;
}

/**
 * Add a new template record.
 * @param {{ name: string, filename: string, fields: object[] }} data
 * @returns {object} The created template record
 */
function createTemplate({ name, filename, fields = [] }) {
  const template = {
    id:        uuidv4(),
    name:      name || path.basename(filename, '.pdf'),
    filename,
    fields,
    mapping:   {},
    createdAt: new Date().toISOString(),
  };

  const all = readCatalogue();
  all.push(template);
  writeCatalogue(all);

  logger.info(`Template created: ${template.name}`, { id: template.id });
  return template;
}

/**
 * Update the CSV→PDF field mapping for a template.
 * @param {string} id
 * @param {object} mapping — { pdfFieldName: csvColumnName }
 * @returns {object|null}
 */
function updateMapping(id, mapping) {
  const all = readCatalogue();
  const idx = all.findIndex(t => t.id === id);
  if (idx === -1) return null;

  all[idx].mapping    = mapping;
  all[idx].updatedAt  = new Date().toISOString();
  writeCatalogue(all);

  logger.info(`Mapping updated for template ${id}`);
  return all[idx];
}

/**
 * Update template display name.
 */
function renameTemplate(id, name) {
  const all = readCatalogue();
  const idx = all.findIndex(t => t.id === id);
  if (idx === -1) return null;
  all[idx].name      = name;
  all[idx].updatedAt = new Date().toISOString();
  writeCatalogue(all);
  return all[idx];
}

/**
 * Delete a template — removes record AND the PDF file.
 */
function deleteTemplate(id) {
  const all      = readCatalogue();
  const template = all.find(t => t.id === id);
  if (!template) return false;

  const pdfPath = path.join(config.templatesDir, template.filename);
  if (fs.existsSync(pdfPath)) {
    try { fs.unlinkSync(pdfPath); } catch {}
  }

  writeCatalogue(all.filter(t => t.id !== id));
  logger.info(`Template deleted: ${id}`);
  return true;
}

module.exports = {
  listTemplates,
  getTemplate,
  createTemplate,
  updateMapping,
  renameTemplate,
  deleteTemplate,
};
