/**
 * src/app.js — Express application factory
 *
 * Configures middleware, mounts routes, and attaches global error handlers.
 * Separated from server.js so the app can be imported in tests without
 * binding a port.
 */

'use strict';

const express = require('express');
const helmet  = require('helmet');
const path    = require('path');

const pdfRoutes      = require('./routes/pdfRoutes');
const templateRoutes = require('./routes/templateRoutes');
const logger         = require('./utils/logger');
const config         = require('./config/config');
const accessToken    = require('./middleware/accessToken');

const app = express();

// ── Security ───────────────────────────────────────────────────────────────
app.use(helmet({
  // PDF.js loads workers as blobs; relax CSP only for the viewer
  contentSecurityPolicy: false,
}));

// ── Access token guard ─────────────────────────────────────────────────────
app.use(accessToken);

// ── Body parsers ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Request logging ────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`);
  next();
});

// ── Static assets (optional front-end) ────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api', pdfRoutes);
app.use('/api/templates', templateRoutes);

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', env: config.nodeEnv, ts: new Date().toISOString() })
);

// ── 404 handler ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error',
  });
});

module.exports = app;
