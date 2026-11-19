const express = require('express');
const { asyncHandler } = require('../../lib/asyncHandler');
const { rateLimit, byIp } = require('../../middleware/rateLimit');
const { idempotency } = require('../../middleware/idempotency');
const { requireAuth, accountOnly } = require('../../middleware/requireAuth');
const { createSocialService } = require('./service');

const SOCIAL_LIMIT = Object.freeze({ name: 'social-login:ip', points: 30, durationSeconds: 3600, key: byIp });

function createSocialRouter({ service } = {}) {
  let built = service;
  const svc = () => (built ??= createSocialService());
  const router = express.Router();
  router.post('/auth/social', rateLimit(SOCIAL_LIMIT), idempotency, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { session, created } = await svc().socialLogin({ ...req.body, installationId: req.get('x-installation-id') });
    res.status(created ? 201 : 200).json(session);
  }));
  router.get('/me/identities', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.json(await svc().listIdentities({ auth: req.auth }));
  }));
  router.post('/me/identities', requireAuth, accountOnly, asyncHandler(async (req, res) => {
    res.status(201).json(await svc().linkIdentity({ auth: req.auth, ...req.body }));
  }));
  return router;
}

module.exports = { createSocialRouter, SOCIAL_LIMIT, router: createSocialRouter() };
