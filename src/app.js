const path = require('node:path');
const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const { config } = require('./config');
const { httpLogger } = require('./lib/logger');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const ROOT = path.join(__dirname, '..');

// Legacy CORS behaviour, unchanged for now (permissive).
const corsOptions = {
  origin(origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:8080',
      'http://localhost:3001',
      'http://localhost:4000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:8080',
      'http://3.10.42.32:3000',
      'https://3.10.42.32:3000',
      'http://3.10.42.32',
      'https://3.10.42.32',
    ];

    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // For development, allow all.
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  optionsSuccessStatus: 200,
};

/**
 * Build the express app. Does not connect to MongoDB and does not listen.
 * @param {{extend?: (app: import('express').Express) => void}} [options]
 *   `extend` is a hook used only by tests to add routes after the legacy
 *   mounts and before the /v1 404 and error handlers.
 */
function createApp({ extend } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(httpLogger);

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(express.json({ limit: '100kb' }));

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

  const v1 = express.Router();
  // v1 routes are added by feature modules; unmatched /v1 paths get a problem 404.
  v1.use(notFound);
  app.use('/v1', v1);

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
