const cors = require('cors');
const helmet = require('helmet');

// Request headers browsers may send cross-origin. The X-Client-* / X-Installation-Id /
// X-Reauth-Token / If-* names come from docs/api/components/parameters.yaml;
// x-api-key is kept for the legacy routes.
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Accept-Language',
  'Idempotency-Key',
  'X-Request-Id',
  'X-Client-Platform',
  'X-Client-Version',
  'X-Installation-Id',
  'X-Reauth-Token',
  'If-Match',
  'If-None-Match',
  'x-api-key',
];

// Response headers scripts may read (docs/api/components/headers.yaml).
// Idempotent-Replayed marks a response replayed for an Idempotency-Key (see middleware/idempotency.js).
const EXPOSED_HEADERS = ['X-Request-Id', 'Retry-After', 'RateLimit', 'ETag', 'Idempotent-Replayed'];

/**
 * CORS middleware with an origin allowlist. A disallowed origin is not an
 * error: the response simply carries no CORS headers, so browsers block it.
 * Requests without an Origin header (mobile apps, curl) pass through.
 * @param {readonly string[]} allowedOrigins
 */
function corsMiddleware(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return cors({
    origin(origin, callback) {
      callback(null, !origin || allowed.has(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
    optionsSuccessStatus: 200,
  });
}

/**
 * helmet with API-safe defaults. Two deliberate choices:
 * - The Swagger UI page at /api-docs uses inline scripts and styles, so only
 *   that path runs without a Content-Security-Policy; every other response
 *   keeps helmet's default CSP.
 * - Cross-Origin-Resource-Policy is `cross-origin` because /uploads serves
 *   avatars and banners that the web app and admin panel embed.
 */
function helmetMiddleware() {
  const options = { crossOriginResourcePolicy: { policy: 'cross-origin' } };
  const standard = helmet(options);
  const docs = helmet({ ...options, contentSecurityPolicy: false });
  return (req, res, next) => (
    req.path === '/api-docs' || req.path.startsWith('/api-docs/')
      ? docs(req, res, next)
      : standard(req, res, next)
  );
}

/**
 * Global security middleware: helmet, then CORS (including preflight).
 * @param {import('express').Express} app
 * @param {{corsOrigins: readonly string[]}} config
 */
function applySecurity(app, config) {
  const corsHandler = corsMiddleware(config.corsOrigins);
  app.use(helmetMiddleware());
  app.use(corsHandler);
  app.options('*', corsHandler);
}

module.exports = { applySecurity, corsMiddleware, helmetMiddleware, ALLOWED_HEADERS, EXPOSED_HEADERS };
