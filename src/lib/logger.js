const crypto = require('node:crypto');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { config } = require('../config');

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.verificationToken',
  '*.code',
  '*.otp',
];

/**
 * Build a pino logger with secret redaction.
 * @param {{level?: string, destination?: object}} [options]
 */
function createLogger({ level = config.logLevel, destination } = {}) {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, destination);
}

const logger = createLogger();

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Build the pino-http middleware: assigns req.id (from a valid X-Request-Id or a
 * new UUID), echoes it in the response header, and logs without request bodies,
 * query strings or response headers.
 * @param {import('pino').Logger} [baseLogger]
 */
function createHttpLogger(baseLogger = logger) {
  return pinoHttp({
    logger: baseLogger,
    // Probes and client mistakes are expected: only unexpected 5xx logs as error.
    customLogLevel(req, res, err) {
      if (res.statusCode >= 500 || err) {
        return String(req.url).split('?')[0].startsWith('/health/ready') ? 'warn' : 'error';
      }
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
    genReqId(req, res) {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : crypto.randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}

const httpLogger = createHttpLogger();

module.exports = { logger, httpLogger, createHttpLogger, createLogger, REDACT_PATHS };
