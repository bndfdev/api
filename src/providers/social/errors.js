const { ApiError } = require('../../lib/problem');

const invalidToken = () => new ApiError({
  status: 401, code: 'SOCIAL_TOKEN_INVALID', title: 'Sign-in credential is invalid',
  detail: 'Sign in with the provider again.',
});
const unsupportedProvider = () => new ApiError({
  status: 422, code: 'SOCIAL_PROVIDER_UNSUPPORTED', title: 'Sign-in method not available',
});
const providerUnavailable = () => new ApiError({
  status: 503, code: 'SERVICE_UNAVAILABLE', title: 'Sign-in provider unavailable', retryAfterSeconds: 30,
});
const nonceMismatch = () => new ApiError({
  status: 401, code: 'SOCIAL_NONCE_MISMATCH', title: 'Sign-in nonce did not match',
});
const unverifiedEmail = () => new ApiError({
  status: 422, code: 'SOCIAL_EMAIL_UNVERIFIED', title: 'Verify your email with the provider first',
});

module.exports = { invalidToken, unsupportedProvider, providerUnavailable, nonceMismatch, unverifiedEmail };
