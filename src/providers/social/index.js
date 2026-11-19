const { config: defaultConfig } = require('../../config');
const { createGoogleVerifier } = require('./google');
const { createFacebookVerifier } = require('./facebook');
const { unsupportedProvider } = require('./errors');

/** Provider switches are enforced even with injected verifier functions. Apple remains disabled. */
function createSocialVerifier({ config = defaultConfig, google, facebook } = {}) {
  const social = config.social || {};
  const verifyGoogle = google || createGoogleVerifier({ clientIds: social.googleClientIds });
  const verifyFacebook = facebook || createFacebookVerifier({ appId: social.facebookAppId, appSecret: social.facebookAppSecret });
  return async function verify(credential = {}) {
    if (credential.provider === 'google' && social.googleClientIds?.length) return verifyGoogle(credential);
    if (credential.provider === 'facebook' && social.facebookAppId && social.facebookAppSecret) return verifyFacebook(credential);
    throw unsupportedProvider();
  };
}

module.exports = { createSocialVerifier };
