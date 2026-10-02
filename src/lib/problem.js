/**
 * RFC 9457 problem helpers. Shape follows `Problem` in docs/api/components/schemas.yaml.
 */
const TYPE_BASE = 'https://api.bondfire.app/errors/';

class ApiError extends Error {
  /**
   * @param {{status: number, code: string, title?: string, detail?: string,
   *   errors?: Array<object>, retryAfterSeconds?: number, headers?: object}} opts
   */
  constructor({ status, code, title, detail, errors, retryAfterSeconds, headers }) {
    super(detail || title || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title || code;
    this.detail = detail;
    this.errors = errors;
    this.retryAfterSeconds = retryAfterSeconds;
    this.headers = headers;
  }
}

function kebab(code) {
  return String(code).toLowerCase().replace(/_/g, '-');
}

/**
 * Write an ApiError as application/problem+json.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {ApiError} err
 */
function sendProblem(req, res, err) {
  const body = {
    type: TYPE_BASE + kebab(err.code),
    title: err.title,
    status: err.status,
    code: err.code,
    requestId: req.id,
    instance: String(req.originalUrl || req.url).split('?')[0],
  };
  if (err.detail) body.detail = err.detail;
  if (err.errors) body.errors = err.errors;
  if (err.retryAfterSeconds !== undefined) {
    body.retryAfterSeconds = err.retryAfterSeconds;
    res.setHeader('Retry-After', String(err.retryAfterSeconds));
  }
  if (err.headers) {
    for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
  }
  res.status(err.status).type('application/problem+json').send(JSON.stringify(body));
}

module.exports = { ApiError, sendProblem };
