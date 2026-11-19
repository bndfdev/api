const { ApiError } = require('../../lib/problem');
const { invalidToken, unsupportedProvider, providerUnavailable } = require('./errors');

const GRAPH_URL = 'https://graph.facebook.com';
const TIMEOUT_MS = 5000;

/** Facebook access tokens only. Every request, including reading its body, has a deadline. */
function createFacebookVerifier({ appId, appSecret, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS } = {}) {
  async function request(url, bearer) {
    const abort = new AbortController();
    let timer;
    try {
      return await Promise.race([
        (async () => {
          const res = await fetchImpl(url, {
            headers: { Authorization: `Bearer ${bearer}` }, signal: abort.signal, redirect: 'error',
          });
          if (!res.ok) {
            if (res.status >= 500 || res.status === 429) throw providerUnavailable();
            throw invalidToken();
          }
          const body = await res.json();
          if (!body || typeof body !== 'object') throw providerUnavailable();
          if (body.error) {
            if ([1, 2, 4, 17, 32, 341, 613].includes(body.error.code) || body.error.is_transient === true) throw providerUnavailable();
            throw invalidToken();
          }
          return body;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(providerUnavailable()); }, timeoutMs);
        }),
      ]);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Never retain an upstream exception: it may contain a credential or a request URL.
      throw providerUnavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return async function verifyFacebook(credential = {}) {
    if (!appId || !appSecret) throw unsupportedProvider();
    if (typeof credential.accessToken !== 'string' || !credential.accessToken || credential.idToken !== undefined) throw invalidToken();
    const debugUrl = new URL(`${GRAPH_URL}/debug_token`);
    debugUrl.searchParams.set('input_token', credential.accessToken);
    const { data } = await request(debugUrl, `${appId}|${appSecret}`);
    const epoch = now() / 1000;
    if (!data || data.is_valid !== true || data.app_id !== appId || typeof data.user_id !== 'string' || !data.user_id ||
        (data.type !== undefined && data.type !== 'USER') || !Number.isFinite(data.expires_at) || data.expires_at <= epoch ||
        (data.data_access_expires_at !== undefined && data.data_access_expires_at !== 0 &&
          (!Number.isFinite(data.data_access_expires_at) || data.data_access_expires_at <= epoch))) throw invalidToken();
    const me = await request(new URL(`${GRAPH_URL}/me?fields=id,name,email`), credential.accessToken);
    if (typeof me.id !== 'string' || me.id !== data.user_id) throw invalidToken();
    // Graph supplies no verified-email assertion. Rule 4 applies even when /me includes an email.
    const result = { provider: 'facebook', providerUserId: me.id };
    if (typeof me.name === 'string') result.name = me.name;
    return result;
  };
}

module.exports = { createFacebookVerifier, GRAPH_URL, TIMEOUT_MS };
