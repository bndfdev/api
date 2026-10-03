/**
 * Refuses app builds older than the minimum supported version for their platform with 426
 * UPGRADE_REQUIRED (docs/api: AppConfig.minimumSupportedVersion, "Older builds receive 426 UPGRADE_REQUIRED
 * on every call"). The app then shows its blocking "Update Bondfire" screen. Mount on /v1 BEFORE the spec
 * validator: an old build may send requests in an older shape and must get 426, not a validation error. A
 * request without the headers is passed on, and the validator refuses it.
 *
 * A version that cannot be read is let through: this is a product gate, not a security check, and a
 * development build ("0.0.0-dev+local") should not be locked out by a typo in its own header.
 */
const { config: defaultConfig } = require('../config');
const { ApiError } = require('../lib/problem');

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** [major, minor, patch], or null when the text is not a version. Pre-release and build parts are ignored. */
function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text.trim()) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}

/** Negative, 0 or positive as `a` is older than, the same as, or newer than `b`. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const upgradeRequired = (minimumVersion) => new ApiError({
  status: 426,
  code: 'UPGRADE_REQUIRED',
  title: 'Update required',
  detail: 'This version of Bondfire is no longer supported. Update the app to continue.',
  meta: { minimumVersion },
});

/** @param {{config?: object}} [deps] */
function createClientVersionGate({ config = defaultConfig } = {}) {
  return function clientVersionGate(req, res, next) {
    const minimum = config.app.minimumVersions[req.get('x-client-platform')];
    const given = parseVersion(req.get('x-client-version'));
    if (!minimum || !given) return next();
    if (compareVersions(given, parseVersion(minimum)) < 0) return next(upgradeRequired(minimum));
    return next();
  };
}

module.exports = { createClientVersionGate, clientVersionGate: createClientVersionGate(), parseVersion, compareVersions };
