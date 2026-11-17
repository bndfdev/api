const { config: defaultConfig } = require('../../config');
const { ApiError } = require('../../lib/problem');
const { randomToken, sha256 } = require('../../lib/secrets');
const { validateDestination, maskDestination } = require('../../lib/destination');
const { assertSupportedLanguage } = require('../../lib/languages');
const { iso } = require('../../lib/time');
const { isSuspended } = require('../users/service');
const { createSocialVerifier } = require('../../providers/social');
const defaultRepo = require('./repo');
const defaultUsers = require('../users/repo');
const defaultSessions = require('../sessions/service');
const defaultProfiles = require('../me/service');

const LINK_TTL_MS = 10 * 60 * 1000;
const problem = (status, code, title) => new ApiError({ status, code, title });
const invalid = () => problem(401, 'SOCIAL_TOKEN_INVALID', 'Provider credential invalid');
const suspended = () => problem(403, 'ACCOUNT_SUSPENDED', 'Account suspended');
const identityResponse = (i) => ({ provider: i.provider, email: i.email || null, linkedAt: iso(i.linkedAt) });

function createSocialService({
  config = defaultConfig, verify = createSocialVerifier({ config }), now = Date.now,
  repo = defaultRepo, users = defaultUsers, sessions = defaultSessions, profiles = defaultProfiles,
} = {}) {
  async function verified(credential) {
    const result = await verify(credential);
    if (!result || !['google', 'facebook'].includes(result.provider) || result.provider !== credential.provider ||
        typeof result.providerUserId !== 'string' || result.providerUserId === '') throw invalid();
    let email;
    if (result.email) {
      if (result.emailVerified !== true) throw problem(422, 'SOCIAL_EMAIL_UNVERIFIED', 'Provider email is not verified');
      email = validateDestination('email', result.email);
      if (!email) throw invalid();
    }
    return { provider: result.provider, providerUserId: result.providerUserId, ...(email ? { email } : {}) };
  }

  async function account(userId) {
    const user = await users.findById(userId);
    if (!user) throw problem(401, 'SESSION_REVOKED', 'Session revoked');
    if (isSuspended(user, now())) throw suspended();
    return user;
  }

  async function needsLink(user, identity) {
    if (isSuspended(user, now())) throw suspended();
    const linkToken = `lnk_${randomToken()}`;
    const at = now();
    await repo.issueLink({ tokenHash: sha256(linkToken), userId: user._id, ...identity,
      createdAt: new Date(at), expiresAt: new Date(at + LINK_TTL_MS) });
    throw new ApiError({ status: 409, code: 'ACCOUNT_LINK_REQUIRED', title: 'You already have an account',
      meta: { linkToken, email: maskDestination('email', identity.email),
        existingLoginMethods: [...new Set([...(user.password ? ['password'] : []), ...(user.socialIdentities || []).map((i) => i.provider)])] } });
  }

  async function socialLogin({ credential, device, installationId, preferredLanguage }) {
    if (device.installationId !== installationId) throw new ApiError({ status: 422, code: 'VALIDATION_FAILED', title: 'Installation does not match',
      errors: [{ field: '/device/installationId', code: 'VALIDATION_FAILED', message: 'Use the installation from the request header.' }] });
    if (preferredLanguage !== undefined) assertSupportedLanguage(preferredLanguage);
    const identity = await verified(credential);
    let user = await repo.findIdentity(identity);
    let created = false;
    if (!user) {
      const collision = identity.email ? await users.findByEmail(identity.email) : null;
      if (collision) await needsLink(collision, identity);
      const at = new Date(now());
      try {
        user = await repo.createUser({ ...(identity.email ? { email: identity.email } : {}), emailVerified: Boolean(identity.email),
          ...(preferredLanguage ? { preferredLanguage } : {}), socialIdentities: [{ ...identity, linkedAt: at }], createdAt: at, updatedAt: at });
        created = true;
      } catch (err) {
        if (err.code !== 11000) throw err;
        // The unique identity index chooses a single account, even when the provider supplies no email.
        user = await repo.findIdentity(identity);
        if (!user && identity.email) {
          const raced = await users.findByEmail(identity.email);
          if (raced) await needsLink(raced, identity);
        }
        if (!user) throw err;
      }
    }
    if (isSuspended(user, now())) throw suspended();
    const { platform, model, appVersion } = device;
    const { tokens, session } = await sessions.createSession({ userId: String(user._id), signInMethod: identity.provider,
      device: { platform, ...(model ? { model } : {}), appVersion }, installationId });
    return { session: { tokens, session, user: await profiles.userView(user), isNewUser: created }, created };
  }

  async function listIdentities({ auth }) {
    const user = await account(auth.userId);
    return { data: [...(user.password ? [{ provider: 'password', email: user.email || null, linkedAt: iso(user.createdAt) }] : []),
      ...(user.socialIdentities || []).map(identityResponse)] };
  }

  async function linkIdentity({ auth, credential, linkToken }) {
    await account(auth.userId);
    const identity = credential ? await verified(credential) : undefined;
    if (!identity && (typeof linkToken !== 'string' || !linkToken.startsWith('lnk_'))) throw problem(401, 'LINK_TOKEN_INVALID', 'Link token invalid');
    let result;
    try {
      result = await repo.link({ userId: auth.userId, identity, tokenHash: linkToken ? sha256(linkToken) : undefined, at: new Date(now()) });
    } catch (err) {
      if (err.code === 11000) throw problem(409, 'IDENTITY_ALREADY_LINKED', 'Identity belongs to another account');
      throw err;
    }
    if (result.invalidToken) throw problem(401, 'LINK_TOKEN_INVALID', 'Link token invalid');
    if (result.missing) throw problem(401, 'SESSION_REVOKED', 'Session revoked');
    return identityResponse(result.identity);
  }

  return { socialLogin, listIdentities, linkIdentity };
}

module.exports = { createSocialService, LINK_TTL_MS };
