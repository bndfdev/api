process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');

const pemPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  };
};

// The smallest valid production environment.
const prodEnv = (extra = {}) => ({
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://x/y',
  ...pemPair(),
  JWT_KEY_ID: 'k1',
  TOKEN_ENC_KEY: crypto.randomBytes(32).toString('base64'),
  CODE_HMAC_KEY: crypto.randomBytes(32).toString('base64'),
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'Bondfire <no-reply@example.com>',
  TRUST_PROXY: '0',
  ...extra,
});

test('loadConfig({}) throws naming MONGODB_URI', () => {
  assert.throws(() => loadConfig({}), /MONGODB_URI/);
});

test('loadConfig does not leak values in the error', () => {
  assert.throws(() => loadConfig({ PORT: 'secret-port-value' }), (err) => !err.message.includes('secret-port-value'));
});

test('loadConfig rejects an invalid PORT by name', () => {
  for (const PORT of ['abc', '-1', '3000x', '65536', '1e3']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT }), (err) => /PORT/.test(err.message) && !err.message.includes(PORT));
  }
  assert.equal(loadConfig({ NODE_ENV: 'test', PORT: '0' }).port, 0);
  assert.equal(loadConfig({ NODE_ENV: 'test', PORT: '65535' }).port, 65535);
});

test('loadConfig({NODE_ENV:"test"}) does not throw and silences logs', () => {
  const cfg = loadConfig({ NODE_ENV: 'test' });
  assert.equal(cfg.isTest, true);
  assert.equal(cfg.logLevel, 'silent');
  assert.equal(cfg.port, 3000);
});

test('loadConfig reads values and freezes the result', () => {
  const cfg = loadConfig(prodEnv({ PORT: '8080', LOG_LEVEL: 'warn' }));
  assert.equal(cfg.isProduction, true);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.logLevel, 'warn');
  assert.ok(Object.isFrozen(cfg));
});

test('corsOrigins: unset gives the dev list outside production and none in production', () => {
  const dev = loadConfig({ NODE_ENV: 'test' });
  assert.ok(dev.corsOrigins.includes('http://localhost:3000'));
  assert.ok(Object.isFrozen(dev.corsOrigins));
  const prod = loadConfig(prodEnv());
  assert.deepEqual([...prod.corsOrigins], []);
  assert.deepEqual([...loadConfig(prodEnv({ CORS_ORIGINS: '   ' })).corsOrigins], []);
});

test('corsOrigins: CORS_ORIGINS is split, trimmed and replaces the dev list', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGINS: ' https://app.bondfire.app , https://admin.bondfire.app/ ,, ',
  });
  assert.deepEqual([...cfg.corsOrigins], ['https://app.bondfire.app', 'https://admin.bondfire.app']);
});

test('token settings: defaults', () => {
  const cfg = loadConfig({ NODE_ENV: 'test' });
  assert.equal(cfg.jwt.accessTtlSeconds, 900);
  assert.equal(cfg.refreshToken.ttlDays, 60);
  assert.equal(cfg.refreshToken.graceSeconds, 30);
  assert.equal(cfg.jwt.issuer, 'bondfire-api');
  assert.equal(cfg.jwt.audience, 'bondfire-app');
  assert.ok(Object.isFrozen(cfg.jwt));
  assert.ok(Object.isFrozen(cfg.refreshToken));
});

test('token settings are read from the environment', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    ACCESS_TOKEN_TTL_SECONDS: '60',
    REFRESH_TOKEN_TTL_DAYS: '7',
    REFRESH_GRACE_SECONDS: '5',
    JWT_ISSUER: 'iss',
    JWT_AUDIENCE: 'aud',
  });
  assert.equal(cfg.jwt.accessTtlSeconds, 60);
  assert.equal(cfg.refreshToken.ttlDays, 7);
  assert.equal(cfg.refreshToken.graceSeconds, 5);
  assert.equal(cfg.jwt.issuer, 'iss');
  assert.equal(cfg.jwt.audience, 'aud');
});

test('token settings must be integers within their range, and the error names the variable only', () => {
  for (const value of ['0', '-5', '1.5', 'abc', '10s']) {
    // (The message states the range, so a value like "0" can appear in it by chance.)
    assert.throws(() => loadConfig({ NODE_ENV: 'test', ACCESS_TOKEN_TTL_SECONDS: value }), /ACCESS_TOKEN_TTL_SECONDS/);
  }
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', ACCESS_TOKEN_TTL_SECONDS: 'secret-looking-value' }),
    (err) => /ACCESS_TOKEN_TTL_SECONDS/.test(err.message) && !err.message.includes('secret-looking-value'),
  );
  assert.throws(() => loadConfig({ NODE_ENV: 'test', REFRESH_TOKEN_TTL_DAYS: 'x' }), /REFRESH_TOKEN_TTL_DAYS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', REFRESH_GRACE_SECONDS: 'x' }), /REFRESH_GRACE_SECONDS/);
});

test('token settings have upper bounds: grace 120 s, access 3600 s, refresh 180 days', () => {
  const limits = { REFRESH_GRACE_SECONDS: 120, ACCESS_TOKEN_TTL_SECONDS: 3600, REFRESH_TOKEN_TTL_DAYS: 180 };
  for (const [name, max] of Object.entries(limits)) {
    const ok = loadConfig({ NODE_ENV: 'test', [name]: String(max) });
    assert.equal(
      { REFRESH_GRACE_SECONDS: ok.refreshToken.graceSeconds, ACCESS_TOKEN_TTL_SECONDS: ok.jwt.accessTtlSeconds, REFRESH_TOKEN_TTL_DAYS: ok.refreshToken.ttlDays }[name],
      max,
    );
    for (const value of [String(max + 1), '999999999999999999999']) {
      assert.throws(
        () => loadConfig({ NODE_ENV: 'test', [name]: value }),
        (err) => err.message.includes(name) && !err.message.includes(value),
        `${name}=${value}`,
      );
    }
  }
});

test('in development and test, missing keys are generated and flagged as ephemeral', () => {
  // An unset NODE_ENV counts as development.
  for (const NODE_ENV of ['test', 'development', undefined]) {
    const cfg = loadConfig({ NODE_ENV, MONGODB_URI: 'mongodb://x/y' });
    assert.equal(cfg.jwt.ephemeral, true);
    assert.equal(cfg.tokenEncKeyEphemeral, true);
    assert.match(cfg.jwt.privateKey, /BEGIN PRIVATE KEY/);
    assert.match(cfg.jwt.publicKey, /BEGIN PUBLIC KEY/);
    assert.ok(cfg.jwt.keyId);
    assert.equal(cfg.tokenEncKey.length, 32);
  }
  // Stable within a process, so every loadConfig() agrees.
  assert.equal(loadConfig({ NODE_ENV: 'test' }).jwt.publicKey, loadConfig({ NODE_ENV: 'test' }).jwt.publicKey);
});

test('configured keys are used as given; literal backslash-n sequences in PEM values are accepted', () => {
  const env = pemPair();
  const escape = (pem) => pem.trim().replaceAll('\n', '\\n');
  const cfg = loadConfig({
    NODE_ENV: 'test',
    JWT_PRIVATE_KEY: escape(env.JWT_PRIVATE_KEY),
    JWT_PUBLIC_KEY: escape(env.JWT_PUBLIC_KEY),
    JWT_KEY_ID: 'k9',
  });
  assert.equal(cfg.jwt.ephemeral, false);
  assert.equal(cfg.jwt.keyId, 'k9');
  assert.equal(cfg.jwt.privateKey, env.JWT_PRIVATE_KEY.trim());
  assert.equal(cfg.jwt.publicKey, env.JWT_PUBLIC_KEY.trim());
});

test('production requires the token variables and names each missing one', () => {
  const base = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y' };
  assert.throws(
    () => loadConfig(base),
    (err) => ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY', 'CODE_HMAC_KEY', 'TRUST_PROXY', 'SMTP_HOST', 'SMTP_FROM'].every((n) => err.message.includes(n)),
  );
  for (const name of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY', 'CODE_HMAC_KEY', 'TRUST_PROXY', 'SMTP_HOST', 'SMTP_FROM']) {
    const env = prodEnv();
    delete env[name];
    assert.throws(() => loadConfig(env), (err) => err.message.includes(name));
  }
  assert.equal(loadConfig(prodEnv()).jwt.ephemeral, false);
});

test('any other NODE_ENV (staging, prod, Development, ...) requires the keys and names each missing variable', () => {
  for (const NODE_ENV of ['staging', 'prod', 'Development', 'qa']) {
    assert.throws(
      () => loadConfig({ NODE_ENV, MONGODB_URI: 'mongodb://x/y' }),
      (err) => ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY', 'CODE_HMAC_KEY', 'TRUST_PROXY'].every((n) => err.message.includes(n)),
      NODE_ENV,
    );
    const cfg = loadConfig({ ...prodEnv(), NODE_ENV });
    assert.equal(cfg.jwt.ephemeral, false);
    assert.equal(cfg.tokenEncKeyEphemeral, false);
  }
  // Without validation (the import-time config) nothing is generated either.
  const unvalidated = loadConfig({ NODE_ENV: 'staging' }, { validate: false });
  assert.equal(unvalidated.jwt.privateKey, undefined);
  assert.equal(unvalidated.tokenEncKey, undefined);
});

test('a key pair with only one half is rejected outside production too', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', JWT_PRIVATE_KEY: pemPair().JWT_PRIVATE_KEY }), /JWT_PUBLIC_KEY/);
});

test('invalid keys are rejected by name without echoing them', () => {
  const good = pemPair();
  const other = pemPair();
  assert.throws(() => loadConfig(prodEnv({ JWT_PRIVATE_KEY: 'not a key' })), (err) => /JWT_PRIVATE_KEY/.test(err.message) && !err.message.includes('not a key'));
  assert.throws(() => loadConfig(prodEnv({ JWT_PUBLIC_KEY: 'not a key' })), /JWT_PUBLIC_KEY/);
  assert.throws(() => loadConfig(prodEnv({ ...good, JWT_PUBLIC_KEY: other.JWT_PUBLIC_KEY })), /does not match/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(
    () => loadConfig(prodEnv({
      JWT_PRIVATE_KEY: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      JWT_PUBLIC_KEY: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
    })),
    /P-256/,
  );
});

test('TOKEN_ENC_KEY must be 32 bytes, base64', () => {
  for (const TOKEN_ENC_KEY of ['c2hvcnQ=', crypto.randomBytes(33).toString('base64')]) {
    assert.throws(
      () => loadConfig(prodEnv({ TOKEN_ENC_KEY })),
      (err) => /TOKEN_ENC_KEY/.test(err.message) && !err.message.includes(TOKEN_ENC_KEY),
    );
  }
  const key = crypto.randomBytes(32);
  assert.ok(loadConfig(prodEnv({ TOKEN_ENC_KEY: key.toString('base64') })).tokenEncKey.equals(key));
});

test('TRUST_PROXY must be set explicitly outside development and test (0 is allowed)', () => {
  for (const NODE_ENV of ['production', 'staging']) {
    for (const TRUST_PROXY of [undefined, '', '  ']) {
      const env = { ...prodEnv(), NODE_ENV, TRUST_PROXY };
      if (TRUST_PROXY === undefined) delete env.TRUST_PROXY;
      assert.throws(() => loadConfig(env), (err) => /TRUST_PROXY/.test(err.message), NODE_ENV);
    }
    assert.equal(loadConfig({ ...prodEnv(), NODE_ENV, TRUST_PROXY: '0' }).trustProxy, false);
    assert.equal(loadConfig({ ...prodEnv(), NODE_ENV, TRUST_PROXY: '1' }).trustProxy, 1);
  }
  // Development and tests default to no proxy.
  assert.equal(loadConfig({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y' }).trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
});

test('trustProxy: off by default, a hop count when set, anything else is rejected by name', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '' }).trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '0' }).trustProxy, false);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: ' 2 ' }).trustProxy, 2);
  assert.equal(loadConfig(prodEnv({ TRUST_PROXY: '10' })).trustProxy, 10);
  // "true" and addresses would let a client choose its own IP address, so only hop counts are accepted.
  for (const TRUST_PROXY of ['true', 'loopback', '-1', '1.5', '11', '10.0.0.1']) {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'test', TRUST_PROXY }),
      (err) => /TRUST_PROXY/.test(err.message) && !err.message.includes(TRUST_PROXY),
    );
  }
});

// ---------------------------------------------------------------------------
// One-time codes, email and SMS
// ---------------------------------------------------------------------------

test('code settings: defaults in development and test (console providers, ephemeral key, no test mode)', () => {
  for (const NODE_ENV of ['test', 'development', undefined]) {
    const cfg = loadConfig({ NODE_ENV, MONGODB_URI: 'mongodb://x/y' });
    assert.equal(cfg.codes.hmacKey.length, 32);
    assert.equal(cfg.codes.hmacKeyEphemeral, true);
    assert.equal(cfg.codes.testMode, false);
    assert.deepEqual([...cfg.codes.testRecipients], []);
    assert.equal(cfg.codes.testValue, undefined);
    assert.equal(cfg.codes.logInDev, false);
    assert.equal(cfg.email.provider, 'console');
    assert.equal(cfg.sms.provider, 'console');
    assert.equal(cfg.email.smtp.port, 587);
    assert.ok(Object.isFrozen(cfg.codes) && Object.isFrozen(cfg.email) && Object.isFrozen(cfg.sms));
  }
  // Stable within a process, so every loadConfig() agrees.
  assert.ok(loadConfig({ NODE_ENV: 'test' }).codes.hmacKey.equals(loadConfig({ NODE_ENV: 'test' }).codes.hmacKey));
});

test('CODE_HMAC_KEY must be 32 bytes, base64, and is used as given', () => {
  for (const CODE_HMAC_KEY of ['c2hvcnQ=', crypto.randomBytes(33).toString('base64')]) {
    assert.throws(
      () => loadConfig(prodEnv({ CODE_HMAC_KEY })),
      (err) => /CODE_HMAC_KEY/.test(err.message) && !err.message.includes(CODE_HMAC_KEY),
    );
  }
  const key = crypto.randomBytes(32);
  const cfg = loadConfig(prodEnv({ CODE_HMAC_KEY: key.toString('base64') }));
  assert.ok(cfg.codes.hmacKey.equals(key));
  assert.equal(cfg.codes.hmacKeyEphemeral, false);
});

test('email: smtp is the default outside development and test, and needs a host and a sender', () => {
  const cfg = loadConfig(prodEnv({ SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p' }));
  assert.equal(cfg.email.provider, 'smtp');
  assert.deepEqual({ ...cfg.email.smtp }, {
    host: 'smtp.example.com', port: 465, secure: true, requireTls: true, user: 'u', pass: 'p', from: 'Bondfire <no-reply@example.com>',
  });
  assert.equal(loadConfig(prodEnv()).email.smtp.secure, false);
  assert.equal(loadConfig(prodEnv()).email.smtp.user, undefined);
  // In development smtp is opt-in and then needs its settings too.
  assert.throws(() => loadConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'smtp' }), /SMTP_HOST, SMTP_FROM/);
});

test('email: invalid provider settings are rejected by name without echoing values', () => {
  assert.throws(() => loadConfig(prodEnv({ EMAIL_PROVIDER: 'sendgrid-secret' })), (err) => /EMAIL_PROVIDER/.test(err.message) && !err.message.includes('sendgrid-secret'));
  assert.throws(() => loadConfig(prodEnv({ SMTP_PORT: '70000' })), /SMTP_PORT/);
  assert.throws(() => loadConfig(prodEnv({ SMTP_PORT: 'abc' })), /SMTP_PORT/);
  assert.throws(() => loadConfig(prodEnv({ SMTP_USER: 'someone' })), /SMTP_USER and SMTP_PASS/);
  assert.throws(() => loadConfig(prodEnv({ SMTP_PASS: 'hunter2' })), (err) => /SMTP_USER and SMTP_PASS/.test(err.message) && !err.message.includes('hunter2'));
  for (const SMTP_FROM of ['not an address', 'a@b\r\nBcc: x@y.z', 'Name <a@b> <c@d>']) {
    assert.throws(() => loadConfig(prodEnv({ SMTP_FROM })), /SMTP_FROM/, JSON.stringify(SMTP_FROM));
  }
  assert.equal(loadConfig(prodEnv({ SMTP_FROM: 'no-reply@example.com' })).email.smtp.from, 'no-reply@example.com');
});

test('sms: only the console provider exists for now', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', SMS_PROVIDER: 'console' }).sms.provider, 'console');
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SMS_PROVIDER: 'twilio' }), /SMS_PROVIDER/);
});

test('phone: every region and VoIP allowed by default; PHONE_REGIONS and PHONE_REFUSE_VOIP narrow it', () => {
  const plain = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(plain.phone.regions, []);
  assert.equal(plain.phone.refuseVoip, false);
  const narrowed = loadConfig({ NODE_ENV: 'test', PHONE_REGIONS: ' us, IN ,,', PHONE_REFUSE_VOIP: 'true' });
  assert.deepEqual(narrowed.phone.regions, ['US', 'IN']);
  assert.equal(narrowed.phone.refuseVoip, true);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PHONE_REGIONS: 'USA' }), /PHONE_REGIONS/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PHONE_REFUSE_VOIP: 'sometimes' }), /PHONE_REFUSE_VOIP/);
});

test('app config: versions default to 1.0.0, switches default on, countries default to US', () => {
  const plain = loadConfig({ NODE_ENV: 'test' });
  assert.deepEqual(plain.app.minimumVersions, { ios: '1.0.0', android: '1.0.0', web: '1.0.0' });
  assert.deepEqual(plain.app.latestVersions, {});
  assert.deepEqual(plain.features, { guestMode: true, phoneVerificationRequired: true });
  assert.deepEqual(plain.countries, { contentRegions: [], defaultCountry: 'US' });
  const set = loadConfig({
    NODE_ENV: 'test', APP_MIN_VERSION_IOS: '1.2.0', APP_LATEST_VERSION_ANDROID: '2.0.1', GUEST_MODE: 'false',
    PHONE_VERIFICATION_REQUIRED: 'false', CONTENT_REGIONS: 'us', DEFAULT_COUNTRY_CODE: 'in',
  });
  assert.equal(set.app.minimumVersions.ios, '1.2.0');
  assert.deepEqual(set.app.latestVersions, { android: '2.0.1' });
  assert.deepEqual(set.features, { guestMode: false, phoneVerificationRequired: false });
  assert.deepEqual(set.countries, { contentRegions: ['US'], defaultCountry: 'IN' });
  const wrong = [
    ['APP_MIN_VERSION_WEB', '1.2'], ['GUEST_MODE', 'off'], ['CONTENT_REGIONS', 'USA'], ['DEFAULT_COUNTRY_CODE', 'India'],
    ['DEFAULT_COUNTRY_CODE', 'UK'], ['CONTENT_REGIONS', 'US,UK'], ['PHONE_REGIONS', 'UK'],
  ];
  for (const [name, value] of wrong) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.throws(() => loadConfig({ NODE_ENV: 'test', APP_MIN_VERSION_IOS: '2.0.0', APP_LATEST_VERSION_IOS: '1.10.0' }), /APP_LATEST_VERSION_IOS/);
  assert.equal(loadConfig({ NODE_ENV: 'test', APP_MIN_VERSION_IOS: '1.9.0', APP_LATEST_VERSION_IOS: '1.10.0' }).app.latestVersions.ios, '1.10.0');
});

test('LOG_CODES_IN_DEV only takes effect in development', () => {
  const base = { MONGODB_URI: 'mongodb://x/y', LOG_CODES_IN_DEV: 'true' };
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).codes.logInDev, true);
  assert.equal(loadConfig(base).codes.logInDev, true); // unset NODE_ENV is development
  assert.equal(loadConfig({ ...base, NODE_ENV: 'test' }).codes.logInDev, false);
  assert.equal(loadConfig(prodEnv({ LOG_CODES_IN_DEV: 'true' })).codes.logInDev, false);
  assert.throws(() => loadConfig({ ...base, LOG_CODES_IN_DEV: 'yes' }), /LOG_CODES_IN_DEV/);
});

test('test mode: listed recipients and a fixed 6-digit value, nothing else is affected', () => {
  const env = prodEnv({ CODE_TEST_MODE: 'true', CODE_TEST_RECIPIENTS: ' Tester@Example.COM , +919999900000,, ', CODE_TEST_VALUE: '246810' });
  const cfg = loadConfig({ ...env, NODE_ENV: 'staging' });
  assert.equal(cfg.codes.testMode, true);
  assert.deepEqual([...cfg.codes.testRecipients], ['tester@example.com', '+919999900000']);
  assert.equal(cfg.codes.testValue, '246810');
  assert.ok(Object.isFrozen(cfg.codes.testRecipients));
  // Off by default, and the other settings are ignored while it is off.
  const off = loadConfig(prodEnv({ CODE_TEST_RECIPIENTS: 'a@b.co', CODE_TEST_VALUE: '123456' }));
  assert.equal(off.codes.testMode, false);
  assert.deepEqual([...off.codes.testRecipients], []);
  assert.equal(off.codes.testValue, undefined);
  assert.equal(loadConfig(prodEnv({ CODE_TEST_MODE: 'false' })).codes.testMode, false);
});

test('test mode: recipients and a 6-digit value are required, and errors never echo them', () => {
  const on = { NODE_ENV: 'test', CODE_TEST_MODE: 'true' };
  assert.throws(() => loadConfig(on), /CODE_TEST_RECIPIENTS.*CODE_TEST_VALUE/);
  assert.throws(() => loadConfig({ ...on, CODE_TEST_RECIPIENTS: 'a@b.co' }), /CODE_TEST_VALUE/);
  assert.throws(() => loadConfig({ ...on, CODE_TEST_VALUE: '123456' }), /CODE_TEST_RECIPIENTS/);
  for (const CODE_TEST_VALUE of ['12345', '1234567', 'abcdef', '12 456']) {
    assert.throws(
      () => loadConfig({ ...on, CODE_TEST_RECIPIENTS: 'a@b.co', CODE_TEST_VALUE }),
      (err) => /CODE_TEST_VALUE/.test(err.message) && !err.message.includes(CODE_TEST_VALUE),
      CODE_TEST_VALUE,
    );
  }
  assert.throws(() => loadConfig({ NODE_ENV: 'test', CODE_TEST_MODE: 'maybe' }), /CODE_TEST_MODE/);
});

test('test mode is allowed only when NODE_ENV is exactly staging, development (or unset) or test', () => {
  const testMode = { CODE_TEST_MODE: 'true', CODE_TEST_RECIPIENTS: 'a@b.co', CODE_TEST_VALUE: '123456' };
  const dev = { MONGODB_URI: 'mongodb://x/y', ...testMode };
  assert.equal(loadConfig({ ...dev, NODE_ENV: 'development' }).codes.testMode, true);
  assert.equal(loadConfig(dev).codes.testMode, true); // unset NODE_ENV is development
  assert.equal(loadConfig({ ...dev, NODE_ENV: 'test' }).codes.testMode, true);
  assert.equal(loadConfig(prodEnv({ ...testMode, NODE_ENV: 'staging' })).codes.testMode, true);

  // Anything else is refused: the name of the variable, never its value.
  for (const NODE_ENV of ['production', 'prod', 'Production', 'PRODUCTION', 'Staging', 'qa', 'live', ' staging', 'staging ']) {
    assert.throws(
      () => loadConfig(prodEnv({ ...testMode, NODE_ENV })),
      (err) => /CODE_TEST_MODE/.test(err.message) && !err.message.includes('123456') && !err.message.includes('a@b.co'),
      JSON.stringify(NODE_ENV),
    );
    // A config that was not validated still fails closed.
    const unvalidated = loadConfig(prodEnv({ ...testMode, NODE_ENV }), { validate: false });
    assert.equal(unvalidated.codes.testMode, false, JSON.stringify(NODE_ENV));
    assert.deepEqual([...unvalidated.codes.testRecipients], []);
    assert.equal(unvalidated.codes.testValue, undefined);
  }
  // Switched off, nothing is refused anywhere.
  assert.equal(loadConfig(prodEnv({ NODE_ENV: 'prod', CODE_TEST_MODE: 'false' })).codes.testMode, false);
});

test('the console email provider is only allowed in development and test (not staging, prod, Production, production)', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'console' }).email.provider, 'console');
  assert.equal(loadConfig({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y', EMAIL_PROVIDER: 'console' }).email.provider, 'console');
  for (const NODE_ENV of ['staging', 'prod', 'Production', 'production']) {
    assert.throws(
      () => loadConfig(prodEnv({ NODE_ENV, EMAIL_PROVIDER: 'console' })),
      (err) => /EMAIL_PROVIDER/.test(err.message) && /development or test/.test(err.message),
      NODE_ENV,
    );
    // Unset means smtp there, and that is accepted.
    assert.equal(loadConfig(prodEnv({ NODE_ENV })).email.provider, 'smtp', NODE_ENV);
  }
});

test('smtp must use TLS everywhere except development and test', () => {
  for (const NODE_ENV of ['staging', 'prod', 'Production', 'production']) {
    assert.equal(loadConfig(prodEnv({ NODE_ENV })).email.smtp.requireTls, true, NODE_ENV);
    assert.equal(loadConfig(prodEnv({ NODE_ENV, SMTP_PORT: '465' })).email.smtp.requireTls, true, NODE_ENV);
  }
  assert.equal(loadConfig({ NODE_ENV: 'test' }).email.smtp.requireTls, false);
  assert.equal(loadConfig({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y' }).email.smtp.requireTls, false);
});
