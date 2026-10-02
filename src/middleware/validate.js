const path = require('node:path');
const OpenApiValidator = require('express-openapi-validator');

const SPEC_PATH = path.join(__dirname, '..', '..', 'docs', 'api', 'dist', 'openapi.yaml');

/**
 * Request validation against the bundled OpenAPI 3.1 spec, for /v1 only.
 * - Requests are always validated.
 * - Responses are validated only when NODE_ENV=test, so contract drift fails
 *   the test suite without costing anything in production.
 * - Security is not enforced here: operations that need a session use the
 *   requireAuth middleware (src/middleware/requireAuth.js) on their route.
 * Mount on a router that is itself mounted at /v1 (the spec's server base path).
 * Returns an array of Express middleware; errors are mapped in errorHandler.
 * @param {{isTest: boolean}} config
 */
function openApiValidator(config) {
  return OpenApiValidator.middleware({
    apiSpec: SPEC_PATH,
    validateRequests: { allowUnknownQueryParameters: false, allErrors: true },
    validateResponses: config.isTest,
    validateSecurity: false,
    validateApiSpec: false,
    ignoreUndocumented: false,
    // Health is unversioned: the spec lists it at the server root, not under /v1.
    ignorePaths: /^(\/v1)?\/health(\/ready)?\/?$/,
  });
}

module.exports = { openApiValidator, SPEC_PATH };
