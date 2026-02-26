/**
 * src/services/pdfService.js — PDF form filling service
 *
 * Uses pdf-lib to:
 *   1. Load a fillable AcroForm PDF template.
 *   2. Fill text / checkbox / dropdown fields from a data row.
 *   3. Flatten the form so fields are baked into the page (prevents editing).
 *   4. Save the filled PDF to a per-batch output directory.
 *
 * Key design decisions:
 *   - The template bytes are loaded ONCE per batch, then cloned per row using
 *     PDFDocument.load() on the same buffer — avoids repeated I/O.
 *   - Each row is processed sequentially inside processBatch to stay
 *     memory-predictable; swap to a concurrency pool (e.g. p-limit) if needed.
 *   - Errors on individual rows are captured in `failedRows` rather than
 *     aborting the entire batch.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PDFDocument, PDFName, rgb } = require('pdf-lib');

const config = require('../config/config');
const logger = require('../utils/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load the PDF template bytes once.
 * @returns {Promise<Buffer>}
 */
async function loadTemplate() {
  const templatePath = path.join(config.templatesDir, config.pdfTemplateName);

  if (!fs.existsSync(templatePath)) {
    throw Object.assign(
      new Error(`PDF template not found: ${templatePath}`),
      { statusCode: 500 }
    );
  }

  return fs.promises.readFile(templatePath);
}

/**
 * Introspect a PDF document and return all AcroForm field names.
 * Useful for the field-auto-detection bonus feature.
 *
 * @param {Buffer} pdfBytes
 * @returns {Promise<string[]>}
 */
async function detectPdfFields(pdfBytes) {
  const doc    = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form   = doc.getForm();
  const fields = form.getFields();
  return fields.map(f => f.getName());
}

/**
 * Fill a single PDF document from a data row, then return the saved bytes.
 *
 * @param {Buffer}  templateBytes — Raw bytes of the template PDF
 * @param {object}  dataRow       — { csvColumn: value }
 * @param {object}  fieldMapping  — { pdfField: csvColumn }
 * @returns {Promise<{ bytes: Uint8Array, warnings: string[] }>}
 */
async function fillPDF(templateBytes, dataRow, fieldMapping) {
  const warnings = [];

  // Load a fresh copy for this row (pdf-lib mutates the document in-place)
  const doc  = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
  const form = doc.getForm();

  for (const [pdfFieldName, csvColumn] of Object.entries(fieldMapping)) {
    const value = dataRow[csvColumn];

    if (value === undefined || value === null || value === '') {
      warnings.push(`Field "${pdfFieldName}": no value for CSV column "${csvColumn}"`);
      continue;
    }

    try {
      // Try to fill as a text field first — the most common case
      const field = form.getField(pdfFieldName);
      const fieldType = field.constructor.name;

      if (fieldType === 'PDFTextField') {
        form.getTextField(pdfFieldName).setText(String(value));

      } else if (fieldType === 'PDFCheckBox') {
        const checked = ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
        checked
          ? form.getCheckBox(pdfFieldName).check()
          : form.getCheckBox(pdfFieldName).uncheck();

      } else if (fieldType === 'PDFDropdown') {
        // Select matching option or skip with warning
        const dropdown = form.getDropdown(pdfFieldName);
        const options  = dropdown.getOptions();
        if (options.includes(String(value))) {
          dropdown.select(String(value));
        } else {
          warnings.push(
            `Dropdown "${pdfFieldName}": value "${value}" not in options [${options.join(', ')}]`
          );
        }

      } else if (fieldType === 'PDFRadioGroup') {
        form.getRadioGroup(pdfFieldName).select(String(value));

      } else {
        warnings.push(`Field "${pdfFieldName}": unsupported field type ${fieldType}`);
      }

    } catch (err) {
      // Field not found in this PDF — log but do not crash
      warnings.push(`Field "${pdfFieldName}": ${err.message}`);
    }
  }

  // Flatten — converts interactive fields to static content
  form.flatten();

  const bytes = await doc.save();
  return { bytes, warnings };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Process an entire CSV batch: fill one PDF per row, save to disk.
 *
 * @param {object[]} rows          — Output of csvService.parseCSV
 * @param {object}   fieldMapping  — { pdfField: csvColumn }
 * @param {string}   batchDir      — Absolute output directory for this batch
 * @param {Function} [onProgress]  — Called after each row: (done, total, row)
 * @returns {Promise<BatchSummary>}
 *
 * @typedef {object} BatchSummary
 * @property {number}   total
 * @property {number}   success
 * @property {number}   failed
 * @property {object[]} errors   — [{ row, file, message }]
 * @property {object[]} warnings — [{ row, file, messages[] }]
 */
async function processBatch(rows, fieldMapping, batchDir, onProgress = null) {
  // Ensure output directory exists
  await fs.promises.mkdir(batchDir, { recursive: true });

  const templateBytes = await loadTemplate();

  const summary = {
    total:    rows.length,
    success:  0,
    failed:   0,
    errors:   [],
    warnings: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const rowIndex = i + 1; // 1-based for human-friendly messages

    // Build a sanitised filename — prefer a unique identifier from the row
    const rawName  = row['name'] || row['full_name'] || row['id'] || `record_${rowIndex}`;
    const safeName = sanitiseFilename(rawName);
    const fileName = `${String(rowIndex).padStart(4, '0')}_${safeName}.pdf`;
    const filePath = path.join(batchDir, fileName);

    try {
      const { bytes, warnings } = await fillPDF(templateBytes, row, fieldMapping);

      await fs.promises.writeFile(filePath, bytes);
      summary.success++;

      if (warnings.length) {
        summary.warnings.push({ row: rowIndex, file: fileName, messages: warnings });
      }

      logger.debug(`Row ${rowIndex}/${rows.length} → ${fileName}`);

    } catch (err) {
      summary.failed++;
      summary.errors.push({ row: rowIndex, message: err.message });
      logger.warn(`Row ${rowIndex} failed`, { message: err.message });
    }

    if (typeof onProgress === 'function') {
      onProgress(i + 1, rows.length, row);
    }
  }

  logger.info('Batch complete', {
    total:   summary.total,
    success: summary.success,
    failed:  summary.failed,
  });

  return summary;
}

/**
 * Return all AcroForm field names from the configured template.
 * Exposed as GET /api/fields for the field-auto-detection feature.
 */
async function getTemplateFields() {
  const bytes = await loadTemplate();
  return detectPdfFields(bytes);
}

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Strip characters that are unsafe in filenames.
 * @param {string} name
 * @returns {string}
 */
function sanitiseFilename(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9_\-. ]/g, '_') // replace unsafe chars
    .replace(/\s+/g, '_')                // spaces → underscore
    .replace(/_{2,}/g, '_')              // collapse repeated underscores
    .slice(0, 80);                       // cap length
}

/**
 * Inspect a PDF file and return all AcroForm fields with their page positions.
 * Positions are in PDF-point coordinates with the Y axis flipped to top-left
 * origin so they align with PDF.js rendering coordinates.
 *
 * @param {string} pdfPath — Absolute path to a PDF file
 * @returns {Promise<Array<{
 *   name: string,
 *   type: string,
 *   page: number,
 *   rect: { x, y, width, height, pageWidth, pageHeight } | null
 * }>>}
 */
async function getFieldsWithPositions(pdfPath) {
  const bytes = await fs.promises.readFile(pdfPath);
  const doc   = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form  = doc.getForm();
  const pages = doc.getPages();

  // Build a map keyed by field name
  const fieldMap = {};
  for (const field of form.getFields()) {
    const name = field.getName();
    fieldMap[name] = {
      name,
      type: field.constructor.name.replace(/^PDF/, ''),
      rect: null,
      page: 0,
    };
  }

  // Walk every page's annotation array to find Widget positions
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const page = pages[pageIndex];
    const { width: pw, height: ph } = page.getSize();

    let annotsArray;
    try {
      const annotsRef = page.node.get(PDFName.of('Annots'));
      if (!annotsRef) continue;
      const resolved = doc.context.lookup(annotsRef);
      if (!resolved || !resolved.array) continue;
      annotsArray = resolved.array;
    } catch { continue; }

    for (const annotRef of annotsArray) {
      let annot;
      try { annot = doc.context.lookup(annotRef); } catch { continue; }
      if (!annot || typeof annot.get !== 'function') continue;

      // Must be a Widget annotation
      const subtype = annot.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Widget') continue;

      // Resolve field name (may be on the widget or on its parent)
      let fieldName = null;
      let T = annot.get(PDFName.of('T'));
      if (!T) {
        try {
          const parentRef = annot.get(PDFName.of('Parent'));
          if (parentRef) {
            const parent = doc.context.lookup(parentRef);
            T = parent && typeof parent.get === 'function' ? parent.get(PDFName.of('T')) : null;
          }
        } catch {}
      }
      if (!T) continue;
      fieldName = typeof T.decodeText === 'function' ? T.decodeText() : String(T);
      if (!fieldMap[fieldName]) continue;

      // Resolve Rect [x1, y1, x2, y2] in PDF pts (bottom-left origin)
      const rectObj = annot.get(PDFName.of('Rect'));
      if (!rectObj || !rectObj.array || rectObj.array.length < 4) continue;

      const num = (o) => {
        if (!o) return 0;
        if (typeof o.asNumber === 'function') return o.asNumber();
        if (typeof o.numberValue === 'number') return o.numberValue;
        return parseFloat(String(o)) || 0;
      };

      const x1 = num(rectObj.array[0]);
      const y1 = num(rectObj.array[1]);
      const x2 = num(rectObj.array[2]);
      const y2 = num(rectObj.array[3]);

      // Flip Y to match top-left origin (PDF.js coordinate system)
      fieldMap[fieldName].rect = {
        x: Math.min(x1, x2),
        y: ph - Math.max(y1, y2),
        width:      Math.abs(x2 - x1),
        height:     Math.abs(y2 - y1),
        pageWidth:  pw,
        pageHeight: ph,
      };
      fieldMap[fieldName].page = pageIndex;
    }
  }

  return Object.values(fieldMap);
}

module.exports = { processBatch, getTemplateFields, getFieldsWithPositions, detectPdfFields, sanitiseFilename };
