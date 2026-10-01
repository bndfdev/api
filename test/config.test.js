process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

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
  const cfg = loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y', PORT: '8080', LOG_LEVEL: 'warn' });
  assert.equal(cfg.isProduction, true);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.logLevel, 'warn');
  assert.ok(Object.isFrozen(cfg));
});

test('corsOrigins: unset gives the dev list outside production and none in production', () => {
  const dev = loadConfig({ NODE_ENV: 'test' });
  assert.ok(dev.corsOrigins.includes('http://localhost:3000'));
  assert.ok(Object.isFrozen(dev.corsOrigins));
  const prod = loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y' });
  assert.deepEqual([...prod.corsOrigins], []);
  assert.deepEqual([...loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://x/y', CORS_ORIGINS: '   ' }).corsOrigins], []);
});

test('corsOrigins: CORS_ORIGINS is split, trimmed and replaces the dev list', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGINS: ' https://app.bondfire.app , https://admin.bondfire.app/ ,, ',
  });
  assert.deepEqual([...cfg.corsOrigins], ['https://app.bondfire.app', 'https://admin.bondfire.app']);
});
