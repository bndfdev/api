const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { userEtagOf, sendCacheable } = require('../../lib/etag');
const defaultAuth = require('../../middleware/requireAuth');
const defaultMe = require('./service');
const defaultLegal = require('../legal/service');

/**
 * The signed-in account (`docs/api/paths/me.yaml`: me get/patch, meOnboarding, meOnboardingStep, meConsents).
 * Accounts and guests both use these; the service decides what a guest may change.
 * @param {{me?: object, legal?: object, auth?: {requireAuth: Function}}} [deps]
 */
function createMeRouter({ me = defaultMe, legal = defaultLegal, auth = defaultAuth } = {}) {
  const { requireAuth } = auth;
  const router = express.Router();
  // Personal data: never stored by shared caches.
  const privateCache = 'private, no-cache';

  // GET /me: on launch, after the tokens are restored. ETag + If-None-Match.
  router.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await me.getMe(req.auth);
    sendCacheable(req, res, user, { cacheControl: privateCache, etag: userEtagOf(user) });
  }));

  // PATCH /me: name, date of birth, gender, language. If-Match guards against changes from another device.
  router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await me.updateMe({ auth: req.auth, patch: req.body, ifMatch: req.get('if-match') });
    res.set('ETag', userEtagOf(user)).set('Cache-Control', privateCache).json(user);
  }));

  // GET /me/onboarding
  router.get('/me/onboarding', requireAuth, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await me.getOnboarding(req.auth));
  }));

  // PUT /me/onboarding/steps/{step}: "Later" on Set up profile, or marking an optional step done.
  router.put('/me/onboarding/steps/:step', requireAuth, asyncHandler(async (req, res) => {
    res.json(await me.updateOnboardingStep({ auth: req.auth, step: req.params.step, status: req.body.status }));
  }));

  // GET /me/consents: accepted documents, newest first.
  router.get('/me/consents', requireAuth, asyncHandler(async (req, res) => {
    res.set('Cache-Control', privateCache).json(await legal.list(req.auth.userId));
  }));

  // POST /me/consents: "Accept" on the Terms screen. 201 when recorded, 200 when it already was.
  router.post('/me/consents', requireAuth, asyncHandler(async (req, res) => {
    const { consent, created } = await legal.accept({
      userId: req.auth.userId,
      accountType: req.auth.accountType,
      documentType: req.body.documentType,
      version: req.body.version,
      ip: req.ip,
      installationId: req.get('x-installation-id'),
    });
    res.status(created ? 201 : 200).json(consent);
  }));

  return router;
}

module.exports = { createMeRouter, router: createMeRouter() };
