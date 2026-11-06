/**
 * Notification switches (docs/api/paths/me.yaml: getNotificationSettings, updateNotificationSettings).
 * The rules only: no HTTP and no database access of its own. Accounts only (the routes refuse guests).
 *
 * - Every switch is on until the user turns it off: a switch never saved reads as `true`.
 * - A change sets only the switches sent (the validator makes sure there is at least one, and nothing else), and
 *   answers with all six.
 */
const { ApiError } = require('../../lib/problem');
const defaultSettings = require('./repo');

/** The switches, in the order of the Notifications screen (the spec's `NotificationSettings`). */
const SWITCHES = Object.freeze([
  'likesAndComments', 'followRequests', 'profileEngagement', 'contributorMetrics', 'yourEngagement', 'newOrTrendingContent',
]);

const accountGone = () => new ApiError({
  status: 401, code: 'SESSION_REVOKED', title: 'Session revoked', detail: 'Sign in again.',
  headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
});

/** The spec's `NotificationSettings` for what is stored: every switch, `true` unless stored as `false`. */
function toNotificationSettings(stored) {
  return Object.fromEntries(SWITCHES.map((key) => [key, stored[key] !== false]));
}

/**
 * @param {{settings?: object, now?: () => number}} [deps]
 */
function createNotificationSettingsService({ settings = defaultSettings, now = Date.now } = {}) {
  /** GET /me/notification-settings. @returns {Promise<object>} `NotificationSettings` */
  async function get(auth) {
    const stored = await settings.find(auth.userId);
    if (!stored) throw accountGone();
    return toNotificationSettings(stored);
  }

  /**
   * PATCH /me/notification-settings.
   * @param {object} auth `req.auth`
   * @param {object} patch some of the switches, as booleans
   * @returns {Promise<object>} `NotificationSettings`
   */
  async function update(auth, patch) {
    const changes = Object.fromEntries(SWITCHES.filter((key) => typeof patch[key] === 'boolean').map((key) => [key, patch[key]]));
    const stored = await settings.update(auth.userId, changes, now());
    if (!stored) throw accountGone();
    return toNotificationSettings(stored);
  }

  return { get, update };
}

module.exports = { createNotificationSettingsService, toNotificationSettings, SWITCHES, ...createNotificationSettingsService() };
