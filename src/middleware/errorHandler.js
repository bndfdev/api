const { ApiError, sendProblem } = require('../lib/problem');
const { allowedMethods } = require('../lib/allowedMethods');

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

/**
 * Turn one express-openapi-validator item into a spec `FieldError`
 * (docs/api/components/schemas.yaml). `message` is a fixed sentence chosen by
 * error kind, never the validator's text, so request values are not echoed.
 * `field` is a JSON pointer for body fields, or the query/path parameter name.
 */
function toFieldError(item) {
  const [, where, ...rest] = item.path.split('/');
  let field;
  if (where === 'body') field = rest.length ? `/${rest.join('/')}` : '/';
  else field = rest.join('/') || where || '/';
  field = field.slice(0, MAX_FIELD_LENGTH);
  const required = typeof item.errorCode === 'string' && item.errorCode.startsWith('required.');
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
function validatorProblem(err) {
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
      errors: err.errors.slice(0, MAX_FIELD_ERRORS).map(toFieldError),
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
    const problem = validatorProblem(err);
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
