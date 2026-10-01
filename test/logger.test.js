process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { createLogger } = require('../src/lib/logger');

test('logger redacts secrets', () => {
  const chunks = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const log = createLogger({ level: 'info', destination });
  log.info({
    body: { password: 'pw-value-1', token: 'tok-value-2', code: '123456' },
    req: { headers: { authorization: 'Bearer abc-value-3', cookie: 'sid=cookie-value-4' } },
  }, 'hello');
  const out = chunks.join('');
  for (const secret of ['pw-value-1', 'tok-value-2', '123456', 'abc-value-3', 'cookie-value-4']) {
    assert.ok(!out.includes(secret), `leaked ${secret}`);
  }
  assert.ok(out.includes('[Redacted]'));
});

test('httpLogger omits query strings and credentials', async () => {
  const express = require('express');
  const request = require('supertest');
  const { createHttpLogger } = require('../src/lib/logger');
  const chunks = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const app = express();
  app.use(createHttpLogger(createLogger({ level: 'info', destination })));
  app.get('/ping', (req, res) => res.cookie('sid', 'set-cookie-value-5').json({ ok: true }));

  await request(app)
    .get('/ping?email=a@b.c&token=query-secret-6')
    .set('Authorization', 'Bearer bearer-secret-7')
    .set('x-api-key', 'apikey-secret-8');

  const out = chunks.join('');
  assert.ok(out.includes('/ping'));
  for (const leaked of ['email=', 'query-secret-6', 'bearer-secret-7', 'apikey-secret-8', 'set-cookie-value-5']) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  }
});
