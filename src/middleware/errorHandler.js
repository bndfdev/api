const { ApiError, sendProblem } = require('../lib/problem');

/** 404 problem for unmatched requests (mounted at the end of /v1). */
function notFound(req, res) {
  sendProblem(req, res, new ApiError({
    status: 404,
    code: 'NOT_FOUND',
    title: 'Not found',
    detail: 'The requested resource does not exist.',
  }));
}

/** Final error handler: maps known errors to problems, hides internals for the rest. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) return sendProblem(req, res, err);

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
