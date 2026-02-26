/**
 * src/services/csvService.js — CSV parsing service
 *
 * Uses csv-parse's streaming API so even a 10 000-row file never loads
 * fully into memory.  Returns a Promise that resolves with an array of
 * plain objects once all rows have been read.
 *
 * Architecture note: this service is intentionally pure (no HTTP / Express
 * coupling) so it can be reused in CLI scripts or an Electron context.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const { parse } = require('csv-parse');
const logger = require('../utils/logger');

/**
 * Parse a CSV file and return an array of row objects.
 *
 * @param {string} filePath   — Absolute path to the CSV file
 * @param {object} [options]
 * @param {string[]} [options.requiredColumns] — Columns that MUST exist
 * @returns {Promise<{ rows: object[], columns: string[] }>}
 */
async function parseCSV(filePath, { requiredColumns = [] } = {}) {
  return new Promise((resolve, reject) => {
    const rows    = [];
    let   columns = null;

    const readStream = fs.createReadStream(filePath, { encoding: 'utf8' });

    const parser = parse({
      columns: true,          // first row → column names
      skip_empty_lines: true,
      trim: true,
      bom: true,              // strip UTF-8 BOM if present
      relax_column_count: true,
    });

    parser.on('readable', () => {
      let record;
      // eslint-disable-next-line no-cond-assign
      while ((record = parser.read()) !== null) {
        // Capture column names from the first record
        if (!columns) {
          columns = Object.keys(record);
          logger.debug('CSV columns detected', { columns });

          // Validate required columns early
          const missing = requiredColumns.filter(c => !columns.includes(c));
          if (missing.length) {
            parser.destroy();
            readStream.destroy();
            return reject(
              Object.assign(new Error(`CSV is missing required columns: ${missing.join(', ')}`), {
                statusCode: 400,
                missingColumns: missing,
              })
            );
          }
        }

        rows.push(record);
      }
    });

    parser.on('error', (err) => {
      logger.error('CSV parse error', { message: err.message });
      reject(Object.assign(err, { statusCode: 400 }));
    });

    parser.on('end', () => {
      logger.info(`CSV parsed: ${rows.length} rows`, { file: path.basename(filePath) });
      resolve({ rows, columns: columns || [] });
    });

    readStream.on('error', (err) => {
      logger.error('CSV read stream error', { message: err.message });
      reject(err);
    });

    readStream.pipe(parser);
  });
}

/**
 * Validate that a fieldMapping object references columns that exist in the CSV.
 *
 * @param {object} fieldMapping  — { pdfField: csvColumn }
 * @param {string[]} csvColumns  — Column names from parseCSV
 * @returns {{ valid: boolean, warnings: string[] }}
 */
function validateFieldMapping(fieldMapping, csvColumns) {
  const warnings = [];
  for (const [pdfField, csvCol] of Object.entries(fieldMapping)) {
    if (!csvColumns.includes(csvCol)) {
      warnings.push(`Mapping "${pdfField}" → "${csvCol}": column "${csvCol}" not found in CSV`);
    }
  }
  return { valid: warnings.length === 0, warnings };
}

module.exports = { parseCSV, validateFieldMapping };
