const express = require('express');
const { ApiError } = require('../../lib/problem');
const { getReadiness } = require('./service');

// Mounted at the server root: the spec lists /health and /health/ready as
// unversioned (docs/api/paths/catalog.yaml). In the app the legacy GET /health
// handler answers first, so only /health/ready is served from this router.
const router = express.Router();

router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

// Readiness: 200 when ready, 503 (same body shape) when a dependency is down.
router.get('/health/ready', (req, res) => {
  const readiness = getReadiness();
  res.set('Cache-Control', 'no-store');
  res.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
});

// Any other method on the health paths: 405 with the methods the spec documents.
router.all(['/health', '/health/ready'], (req, res, next) => {
  next(new ApiError({
    status: 405,
    code: 'METHOD_NOT_ALLOWED',
    title: 'Method not allowed',
    detail: 'This method is not supported for the resource.',
    headers: { Allow: 'GET, HEAD' },
  }));
});

module.exports = { router };
