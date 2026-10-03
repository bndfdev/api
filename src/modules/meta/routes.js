const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { sendCacheable } = require('../../lib/etag');
const defaultMeta = require('./service');
const defaultLegal = require('../legal/service');

/**
 * Public reads the app makes before sign-in (`docs/api/paths/catalog.yaml`: config, countries, legalDocument).
 * Each answers with an ETag and honours If-None-Match (304).
 * @param {{meta?: object, legal?: object}} [deps]
 */
function createMetaRouter({ meta = defaultMeta, legal = defaultLegal } = {}) {
  const router = express.Router();

  // GET /config: first call on every launch.
  router.get('/config', (req, res) => {
    sendCacheable(req, res, meta.appConfig(), { cacheControl: 'public, max-age=300' });
  });

  // GET /countries: the phone picker. Localised, so caches must keep one copy per language.
  router.get('/countries', (req, res) => {
    res.set('Vary', 'Accept-Language');
    const body = meta.countries({
      acceptLanguage: req.get('accept-language'),
      // Set by CloudFront or Cloudflare when the API sits behind one; only used to preselect a country.
      viewerCountry: req.get('cloudfront-viewer-country') || req.get('cf-ipcountry'),
    });
    sendCacheable(req, res, body, { cacheControl: 'public, max-age=86400' });
  });

  // GET /legal/{documentType}: the Terms screen.
  router.get('/legal/:documentType', asyncHandler(async (req, res) => {
    sendCacheable(req, res, legal.getDocument(req.params.documentType), { cacheControl: 'public, max-age=3600' });
  }));

  return router;
}

module.exports = { createMetaRouter, router: createMetaRouter() };
