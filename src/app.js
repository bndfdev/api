const path = require('node:path');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const { config } = require('./config');
const { httpLogger } = require('./lib/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { applySecurity } = require('./middleware/security');
const { openApiValidator } = require('./middleware/validate');
const { trimEmail } = require('./middleware/trimEmail');
const { router: healthRouter } = require('./modules/health/routes');
const { router: sessionsRouter } = require('./modules/sessions/routes');
const { router: defaultAuthRouter } = require('./modules/auth/routes');
const { router: defaultPhoneRouter } = require('./modules/phone/routes');
const { router: defaultMeRouter } = require('./modules/me/routes');
const { router: defaultMetaRouter } = require('./modules/meta/routes');
const { clientVersionGate: defaultVersionGate } = require('./middleware/clientVersion');

const ROOT = path.join(__dirname, '..');

/**
 * Build the express app. Does not connect to MongoDB and does not listen.
 * @param {{extend?: (app: import('express').Express) => void, trustProxy?: number | false,
 *   authRouter?: import('express').Router, phoneRouter?: import('express').Router, meRouter?: import('express').Router,
 *   metaRouter?: import('express').Router, versionGate?: Function}} [options]
 *   `extend` is a hook used only by tests to add routes after the legacy
 *   mounts and before the /v1 404 and error handlers. `trustProxy` overrides
 *   config.trustProxy (tests). `authRouter` replaces the sign-up and login
 *   routes (tests give them a fake email provider and a clock, see
 *   createAuthRouter in src/modules/auth/routes.js); `phoneRouter`, `meRouter` and `metaRouter` likewise
 *   replace those routes, and `versionGate` the minimum-app-version check.
 */
function createApp({
  extend,
  trustProxy = config.trustProxy,
  authRouter = defaultAuthRouter,
  phoneRouter = defaultPhoneRouter,
  meRouter = defaultMeRouter,
  metaRouter = defaultMetaRouter,
  versionGate = defaultVersionGate,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  // How many proxies sit in front of the API (TRUST_PROXY); decides what req.ip is.
  app.set('trust proxy', trustProxy);
  app.use(httpLogger);

  applySecurity(app, config);

  // PATCH /v1/me sends JSON Merge Patch (application/merge-patch+json), which is JSON too.
  app.use(express.json({ limit: '100kb', type: ['application/json', 'application/merge-patch+json'] }));

  // Serve uploaded files from API public directory
  app.use('/uploads', express.static(path.join(ROOT, 'public/uploads')));
  // Also serve uploads from admin-panel for backward compatibility
  app.use('/uploads', express.static(path.join(ROOT, '../admin-panel/public/uploads')));

  // Legacy routes (same order and paths as before)
  app.use('/user', require('../routes/user'));
  app.use('/', require('../routes/artist'));
  app.use('/', require('../routes/genre'));
  app.use('/countries', require('../routes/country'));
  app.use('/', require('../routes/recordingRoutes'));
  app.use('/', require('../routes/publishedAudio'));

  app.get('/', (req, res) => {
    res.send('Bondfire API is running');
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      message: 'API is healthy',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * @swagger
   * /users:
   *   get:
   *     summary: Get all users
   *     description: Returns a list of all users (placeholder).
   *     tags:
   *       - User
   *     responses:
   *       200:
   *         description: List of users
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   */
  app.get('/users', (req, res) => {
    res.json({ message: 'List users - placeholder' });
  });

  const serverUrl = config.apiBaseUrl || `http://localhost:${config.port}`;
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Bondfire API',
        version: '1.0.0',
        description: 'API documentation for Bondfire',
      },
      servers: [{ url: serverUrl, description: 'API Server' }],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'verificationToken',
            description: 'Enter the verificationToken value stored in SharedPreferences',
          },
        },
      },
      security: [{ ApiKeyAuth: [] }],
    },
    apis: [path.join(ROOT, 'routes', '*.js').replaceAll('\\', '/')],
  });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  if (extend) extend(app);

  // The spec documents /health and /health/ready as unversioned (root only).
  // The legacy GET /health above answers first; the router adds /health/ready.
  app.use(healthRouter);

  const v1 = express.Router();
  // Every /v1 request is validated against the OpenAPI spec first. Feature
  // modules mount after the validator; documented-but-unimplemented operations
  // and unknown paths fall through to the problem 404.
  v1.use(trimEmail);
  // App builds older than the minimum for their platform get 426 UPGRADE_REQUIRED, before anything else is
  // checked: an old build may send requests in an older shape, and must see "update", not a validation error.
  v1.use(versionGate);
  v1.use(openApiValidator(config));
  v1.use(metaRouter);
  v1.use(sessionsRouter);
  v1.use(authRouter);
  v1.use(phoneRouter);
  v1.use(meRouter);
  v1.use(notFound);
  app.use('/v1', v1);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
