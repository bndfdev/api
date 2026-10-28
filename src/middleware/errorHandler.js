const { ApiError, sendProblem } = require('../lib/problem');
const { allowedMethods } = require('../lib/allowedMethods');
const { unmetRules, policyFieldError } = require('../lib/passwords');

/** 404 problem for unmatched requests (mounted at the end of /v1). */
function notFound(req, res) {
  sendProblem(req, res, new ApiError({
    status: 404,
    code: 'NOT_FOUND',
    title: 'Not found',
    detail: 'The requested resource does not exist.',
  }));
}

const MAX_FIELD_ERRORS = 50;
const MAX_FIELD_LENGTH = 200;

function isValidatorError(err) {
  return Boolean(err) && Number.isInteger(err.status) && Array.isArray(err.errors) &&
    err.errors.every((item) => item && typeof item.path === 'string');
}

// The operations that take a new password, and the body field it is in. The spec's `Password` schema has a
// length range, which the validator checks before any handler runs; a password that is too short or too
// long is reported here the way the spec describes it (PASSWORD_POLICY_VIOLATION, with every rule the
// password breaks in `meta.unmetRules`), not as a generic invalid value.
const NEW_PASSWORD_FIELD = Object.freeze({
  '/v1/auth/signup/complete': 'password',
  '/v1/auth/password-reset/complete': 'newPassword',
  '/v1/me/password': 'newPassword',
});

function newPasswordField(req) {
  const path = String((req && req.originalUrl) || '').split('?')[0].replace(/\/+$/, '');
  return NEW_PASSWORD_FIELD[path];
}

/**
 * Turn one express-openapi-validator item into a spec `FieldError`
 * (docs/api/components/schemas.yaml). `message` is a fixed sentence chosen by
 * error kind, never the validator's text, so request values are not echoed.
 * `field` is a JSON pointer for body fields, or the query/path parameter name.
 * An email that is not an address is EMAIL_INVALID, and a new password with a bad
 * length is PASSWORD_POLICY_VIOLATION, as the spec's operations list them.
 * @param {object} item
 * @param {import('express').Request} [req]
 */
function toFieldError(item, req) {
  const [, where, ...rest] = item.path.split('/');
  let field;
  if (where === 'body') field = rest.length ? `/${rest.join('/')}` : '/';
  else field = rest.join('/') || where || '/';
  field = field.slice(0, MAX_FIELD_LENGTH);
  const required = typeof item.errorCode === 'string' && item.errorCode.startsWith('required.');
  const kind = typeof item.errorCode === 'string' ? item.errorCode.split('.')[0] : '';
  if (field === '/email' && kind === 'format') {
    return { field, code: 'EMAIL_INVALID', message: 'Enter a valid email address.' };
  }
  const passwordField = newPasswordField(req);
  if (passwordField && field === `/${passwordField}` && (kind === 'minLength' || kind === 'maxLength')) {
    const unmet = unmetRules(req.body && req.body[passwordField]);
    if (unmet.length > 0) return policyFieldError(field, unmet);
  }
  return {
    field,
    code: 'VALIDATION_FAILED',
    message: required ? 'This field is required.' : 'This value is not valid.',
  };
}

/**
 * Map express-openapi-validator errors to the spec's problems:
 * 404 NOT_FOUND, 405 METHOD_NOT_ALLOWED with an Allow header from the spec, 415 UNSUPPORTED_MEDIA_TYPE, 400 MALFORMED_REQUEST
 * for a missing body or a missing/invalid header (responses.yaml#/BadRequest),
 * and 422 VALIDATION_FAILED with errors[] for invalid body, query or path
 * values (responses.yaml#/Unprocessable).
 */
function validatorProblem(err, req) {
  if (err.status === 404) {
    return new ApiError({ status: 404, code: 'NOT_FOUND', title: 'Not found', detail: 'The requested resource does not exist.' });
  }
  if (err.status === 405) {
    const allow = allowedMethods(err.errors[0].path);
    return new ApiError({
      status: 405,
      code: 'METHOD_NOT_ALLOWED',
      title: 'Method not allowed',
      detail: 'This method is not supported for the resource.',
      headers: allow ? { Allow: allow } : undefined,
    });
  }
  if (err.status === 413) {
    return new ApiError({ status: 413, code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' });
  }
  if (err.status === 415) {
    // No Content-Type at all means the client sent no body to a route that needs one.
    if (/undefined$/.test(String(err.errors[0].message))) {
      return new ApiError({ status: 400, code: 'MALFORMED_REQUEST', title: 'Malformed request', detail: 'The request body is required.' });
    }
    return new ApiError({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type', detail: 'Send the request as application/json.' });
  }
  if (err.status === 400) {
    const headerErrors = err.errors.filter((item) => item.path.startsWith('/headers/'));
    if (headerErrors.length > 0) {
      return new ApiError({
        status: 400,
        code: 'MALFORMED_REQUEST',
        title: 'Malformed request',
        detail: 'A required request header is missing or invalid.',
        errors: headerErrors.slice(0, MAX_FIELD_ERRORS).map((item) => ({
          field: item.path.slice('/headers/'.length).slice(0, MAX_FIELD_LENGTH),
          code: 'MALFORMED_REQUEST',
          message: 'This header is missing or invalid.',
        })),
      });
    }
    return new ApiError({
      status: 422,
      code: 'VALIDATION_FAILED',
      title: 'Some details need fixing',
      errors: err.errors.slice(0, MAX_FIELD_ERRORS).map((item) => toFieldError(item, req)),
    });
  }
  return null;
}

/** Final error handler: maps known errors to problems, hides internals for the rest. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) return sendProblem(req, res, err);

  if (isValidatorError(err)) {
    const problem = validatorProblem(err, req);
    if (problem) return sendProblem(req, res, problem);
  }

  if (err && err.type === 'entity.parse.failed') {
    return sendProblem(req, res, new ApiError({
      status: 400,
      code: 'MALFORMED_REQUEST',
      title: 'Malformed request',
      detail: 'The request body is not valid JSON.',
    }));
  }

  if (err && err.type === 'entity.too.large') {
    return sendProblem(req, res, new ApiError({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      title: 'Payload too large',
    }));
  }

  const status = err && (err.status || err.statusCode);
  if (err && err.expose === true && Number.isInteger(status) && status >= 400 && status < 500) {
    const mapped = {
      413: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' },
      415: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type' },
    }[status] || { code: 'MALFORMED_REQUEST', title: 'Malformed request' };
    return sendProblem(req, res, new ApiError({ status, ...mapped }));
  }

  if (req.log) req.log.error({ err }, 'unhandled error');
  return sendProblem(req, res, new ApiError({
    status: 500,
    code: 'INTERNAL_ERROR',
    title: 'Internal server error',
  }));
}

module.exports = { notFound, errorHandler };
