process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');
const { ipBucket } = require('../src/lib/ip');
const { rateLimit, byIp } = require('../src/middleware/rateLimit');

// No database needed: the counters are in memory under test.
let counter = 0;
const uniqueName = () => `trust-proxy-${(counter += 1)}`;

function appWith(trustProxy) {
  return createApp({
    trustProxy,
    extend(app) {
      app.get('/test/ip', (req, res) => res.json({ ip: req.ip }));
      app.get('/test/limited', rateLimit({ name: uniqueName(), points: 1, durationSeconds: 60, key: byIp }), (req, res) => res.json({ ok: true }));
    },
  });
}

const forwarded = (app, path, address) => request(app).get(path).set('X-Forwarded-For', address);

test('X-Forwarded-For is ignored by default: the caller cannot pick its own IP', async () => {
  const app = createApp({
    extend(application) {
      application.get('/test/ip', (req, res) => res.json({ ip: req.ip }));
    },
  });
  const res = await forwarded(app, '/test/ip', '203.0.113.5');
  assert.equal(res.status, 200);
  assert.notEqual(res.body.ip, '203.0.113.5');
  assert.match(res.body.ip, /127\.0\.0\.1|::1/);
});

test('with TRUST_PROXY=1 the address added by the one proxy is used, not what the client claims', async () => {
  const app = appWith(1);
  assert.equal((await forwarded(app, '/test/ip', '203.0.113.5')).body.ip, '203.0.113.5');
  // A client can prepend anything; the proxy's own entry (the last) is the one that counts.
  assert.equal((await forwarded(app, '/test/ip', '198.51.100.99, 203.0.113.5')).body.ip, '203.0.113.5');
});

test('rate limits count the real client behind a trusted proxy and the proxy itself when none is trusted', async () => {
  const untrusted = appWith(false);
  assert.equal((await forwarded(untrusted, '/test/limited', '203.0.113.1')).status, 200);
  // Same socket address, a different claimed IP: still the same caller.
  assert.equal((await forwarded(untrusted, '/test/limited', '203.0.113.2')).status, 429);

  const trusted = appWith(1);
  assert.equal((await forwarded(trusted, '/test/limited', '203.0.113.1')).status, 200);
  assert.equal((await forwarded(trusted, '/test/limited', '203.0.113.2')).status, 200);
  assert.equal((await forwarded(trusted, '/test/limited', '203.0.113.1')).status, 429);
});

test('IPv6 clients are limited by their /64 prefix, IPv4 clients by their address', async () => {
  const app = appWith(1);
  assert.equal((await forwarded(app, '/test/limited', '2001:db8:1:2:aaaa::1')).status, 200);
  // Another address in the same /64: the same caller.
  assert.equal((await forwarded(app, '/test/limited', '2001:db8:1:2:bbbb:cccc:dddd:2')).status, 429);
  // A different /64 is a different caller.
  assert.equal((await forwarded(app, '/test/limited', '2001:db8:1:3::1')).status, 200);
  // IPv4 is unchanged: neighbours are separate callers.
  assert.equal((await forwarded(app, '/test/limited', '198.51.100.7')).status, 200);
  assert.equal((await forwarded(app, '/test/limited', '198.51.100.8')).status, 200);
  assert.equal((await forwarded(app, '/test/limited', '198.51.100.7')).status, 429);
});

test('ipBucket: IPv4 unchanged, IPv4-mapped IPv6 is that IPv4, IPv6 is its /64', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:DB8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:0db8:0001:0002:0000:0000:0000:0001'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('2001:db8::'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  assert.equal(ipBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipBucket('64:ff9b::198.51.100.7'), '64:ff9b:0:0::/64');
  // Not an address: counted as it is, never thrown on.
  assert.equal(ipBucket('garbage'), 'garbage');
  assert.equal(ipBucket(''), undefined);
  assert.equal(ipBucket(undefined), undefined);
});
