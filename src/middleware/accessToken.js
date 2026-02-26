/**
 * src/middleware/accessToken.js — Optional token-based route protection
 *
 * If ACCESS_TOKEN is set in the environment, every request to the GUI and
 * API must supply the token via one of:
 *   • Query param  ?token=<token>
 *   • HTTP header  x-access-token: <token>
 *   • HTTP header  Authorization: Bearer <token>
 *
 * Tokens are compared using a constant-time comparison to prevent
 * timing-based side-channel attacks.
 *
 * When ACCESS_TOKEN is not configured, all requests are allowed through
 * (suitable for local development).
 */

'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still run the comparison to avoid length-leaking timing attacks
    crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const EXPECTED_TOKEN = (process.env.ACCESS_TOKEN || '').trim();

if (!EXPECTED_TOKEN) {
  logger.warn('ACCESS_TOKEN is not set — GUI is publicly accessible. Set it in .env for production.');
}

/**
 * Express middleware factory.
 * @returns {import('express').RequestHandler}
 */
function accessTokenMiddleware(req, res, next) {
  // Bypass if protection is disabled
  if (!EXPECTED_TOKEN) return next();

  // Allow health check without token
  if (req.path === '/health') return next();

  const fromQuery  = (req.query.token || '').trim();
  const fromHeader = (req.headers['x-access-token'] || '').trim();
  const bearerHeader = (req.headers['authorization'] || '');
  const fromBearer = bearerHeader.startsWith('Bearer ')
    ? bearerHeader.slice(7).trim()
    : '';

  const supplied = fromQuery || fromHeader || fromBearer;

  if (safeCompare(supplied, EXPECTED_TOKEN)) {
    // Expose the token in res.locals so it can be forwarded by the SPA
    res.locals.accessToken = supplied;
    return next();
  }

  logger.warn(`Access denied: ${req.method} ${req.originalUrl} (invalid or missing token)`);

  // API requests get JSON; browser requests get a minimal HTML gate
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Access denied. Provide a valid token.' });
  }

  // Serve a minimal token-entry page instead of a blank 401
  return res.status(401).send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Access Required</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;
       background:#0f172a;font-family:system-ui,sans-serif;color:#e2e8f0}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;
        padding:2.5rem;width:360px;text-align:center}
  h1{font-size:1.25rem;margin-bottom:.5rem;color:#f8fafc}
  p{font-size:.875rem;color:#94a3b8;margin-bottom:1.5rem}
  input{width:100%;padding:.65rem 1rem;border-radius:8px;border:1px solid #475569;
        background:#0f172a;color:#f1f5f9;font-size:.9rem;outline:none;margin-bottom:1rem}
  input:focus{border-color:#6366f1}
  button{width:100%;padding:.7rem;border-radius:8px;border:none;
         background:#6366f1;color:#fff;font-size:.9rem;cursor:pointer;font-weight:600}
  button:hover{background:#4f46e5}
</style>
</head>
<body>
<div class="card">
  <h1>🔐 Access Required</h1>
  <p>Enter your access token to continue</p>
  <input id="t" type="password" placeholder="Access token" autofocus />
  <button onclick="go()">Enter</button>
</div>
<script>
  function go(){
    const t = document.getElementById('t').value.trim();
    if(t) window.location.href = '/?token=' + encodeURIComponent(t);
  }
  document.getElementById('t').addEventListener('keydown', e => { if(e.key==='Enter') go(); });
</script>
</body></html>`);
}

module.exports = accessTokenMiddleware;
