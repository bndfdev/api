/**
 * The spec's `Email` schema says "The server trims whitespace", but the request
 * validator checks the address exactly as sent, so " a@b.com " would be refused
 * before any handler could trim it. This runs first and trims the `email` of a
 * JSON body. Everything else about the address is still checked by the validator.
 * @type {import('express').RequestHandler}
 */
function trimEmail(req, res, next) {
  const body = req.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && typeof body.email === 'string') {
    body.email = body.email.trim();
  }
  next();
}

module.exports = { trimEmail };
