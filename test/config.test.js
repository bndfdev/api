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
    (err) => ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY'].every((n) => err.message.includes(n)),
  );
  for (const name of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY']) {
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
      (err) => ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_KEY_ID', 'TOKEN_ENC_KEY'].every((n) => err.message.includes(n)),
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
