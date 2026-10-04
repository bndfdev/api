process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/lib/logger');
const { ApiError, sendProblem } = require('../src/lib/problem');
const {
  normalizeEmail, normalizeDestination, isValidEmail, validateDestination, maskDestination,
} = require('../src/lib/destination');
const { emailMessage, smsMessage } = require('../src/providers/messages');
const { createConsoleEmailProvider } = require('../src/providers/email/console');
const { createConsoleSmsProvider } = require('../src/providers/sms/console');
const { createMemoryEmailProvider } = require('../src/providers/email/memory');
const { createMemorySmsProvider } = require('../src/providers/sms/memory');
const { createSmtpEmailProvider, smtpTransportOptions } = require('../src/providers/email/smtp');
const { createEmailProvider } = require('../src/providers/email');
const { createSmsProvider } = require('../src/providers/sms');

/** A logger that writes to an array of lines, at the real log level. */
function captureLogger() {
  const lines = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination }) };
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

test('emails are trimmed and lowercased, and an international domain becomes punycode', () => {
  assert.equal(normalizeEmail('  Amelia.Jane@EXAMPLE.com '), 'amelia.jane@example.com');
  assert.equal(normalizeEmail('amelia+tag@Example.com'), 'amelia+tag@example.com');
  assert.equal(normalizeEmail('user@bücher.example'), 'user@xn--bcher-kva.example');
  assert.equal(normalizeDestination('email', ' A@B.co '), 'a@b.co');
  // A phone number is only trimmed for now (E.164 parsing arrives with phone verification).
  assert.equal(normalizeDestination('sms', ' +14155550123 '), '+14155550123');
});

test('masking hides most of the address and does not reveal its length', () => {
  assert.equal(maskDestination('email', 'amelia.jane@example.com'), 'a•••••e@example.com');
  assert.equal(maskDestination('email', 'a-much-longer-local-part@example.com'), 'a•••••t@example.com');
  assert.equal(maskDestination('email', 'ab@example.com'), 'a•••••@example.com');
  assert.equal(maskDestination('email', 'a@example.com'), '•••••@example.com');
  // A phone number keeps its country code and last 4 digits; one whose country cannot be read hides it too.
  assert.equal(maskDestination('sms', '+14155550123'), '+1 ••• ••• 0123');
  assert.equal(maskDestination('sms', '+919876543210'), '+91 ••• ••• 3210');
  assert.equal(maskDestination('sms', '+9991234567'), '+••• ••• 4567');
  for (const masked of [maskDestination('email', 'amelia.jane@example.com'), maskDestination('sms', '+14155550123')]) {
    assert.ok(!masked.includes('amelia.jane') && !masked.includes('4155550'));
  }
});

test('an email must be exactly one plain address: the dangerous shapes are refused', () => {
  const bad = [
    'a@b.com:x@y.z', // two "@" and a colon (an old-style route)
    'a@b.com(evil@x.com)', // a comment holding a second address
    'a@b.com,evil@x.com', 'a@b.com;evil@x.com', 'a@b.com evil@x.com', 'a b@c.co', ' a@b.co', 'a@b.co ',
    'a@b@c.co', 'a@@b.co', '@b.co', 'a@', 'a', '', 'a@b', 'a@b.', 'a@.co', 'a@-b.co', 'a@b-.co', 'a@b..co',
    '"a"@b.co', '"a b"@c.co', 'Name <a@b.co>', '<a@b.co>', 'a@b.co>', 'a(b)@c.co', 'a\\b@c.co', 'a[b]@c.co',
    'a!b@c.co', 'a%b@c.co', 'a@b.co/x', 'a@b.co:25', 'a@b.co?x=1', 'a@b.co#x', 'a@b.co\\x', 'a@user:pw@b.co',
    'a@b_c.co', 'a@[1.2.3.4]', 'a@1.2.3.4',
    '.a@b.co', 'a.@b.co', 'a..b@c.co', 'a\r\n@b.co', 'a@b.co\r\nBcc: x@y.z', 'a\u0000@b.co', 'a\t@b.co', 'a@b.co\u007f',
    'josé@example.com', // a non-ASCII local part is not supported
    `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(64)}.com`, `${'a'.repeat(64)}@${'b.'.repeat(100)}com`,
  ];
  for (const value of bad) {
    assert.equal(isValidEmail(value), false, JSON.stringify(value));
    // (Surrounding whitespace alone is fixed by normalising; the checker itself never fixes anything.)
    if (value.trim() === value) assert.equal(validateDestination('email', value), null, JSON.stringify(value));
  }
  for (const value of [undefined, null, 5, {}, ['a@b.co']]) {
    assert.equal(isValidEmail(value), false);
    assert.equal(validateDestination('email', value), null);
  }
});

test('ordinary addresses are accepted, and are normalised before they are checked', () => {
  for (const value of ['a@b.co', 'amelia.jane@example.com', 'amelia+tag@example.com', "o'brien@example.com", 'a_b-c@sub.example.co.uk', 'x@xn--bcher-kva.example']) {
    assert.equal(isValidEmail(value), true, value);
  }
  assert.equal(validateDestination('email', '  Amelia.Jane@EXAMPLE.com\n'), 'amelia.jane@example.com');
  assert.equal(validateDestination('email', 'user@bücher.example'), 'user@xn--bcher-kva.example');
  // Exactly 254 characters is the longest address.
  const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
  assert.equal(longest.length, 254);
  assert.equal(isValidEmail(longest), true);
  assert.equal(isValidEmail(`a${longest}`), false);
});

test('variants of one address become the same destination, so they cannot dodge a per-address limit', () => {
  const variants = ['amelia@example.com', 'AMELIA@example.com', ' amelia@EXAMPLE.COM ', 'Amelia@Example.Com\t'];
  assert.deepEqual([...new Set(variants.map((v) => validateDestination('email', v)))], ['amelia@example.com']);
});

test('a phone number loses its spaces, dashes and parentheses, and must then look like E.164', () => {
  for (const value of ['+14155550123', '+1 415 555 0123', '+1 (415) 555-0123', ' +1-415-555-0123 ', '+1(415)5550123']) {
    assert.equal(normalizeDestination('sms', value), '+14155550123', value);
    assert.equal(validateDestination('sms', value), '+14155550123', value);
  }
  for (const value of ['4155550123', '+0415555012', '+1415', '+1415555012345678', '+1 415 555 01a3', '++14155550123', '', 'call me', '+1 415 555 0123;x']) {
    assert.equal(validateDestination('sms', value), null, value);
  }
});

// ---------------------------------------------------------------------------
// Message templates
// ---------------------------------------------------------------------------

test('messages are fixed text with only the code and the number of minutes filled in', () => {
  for (const purpose of ['signup_email', 'password_reset', 'phone_verification']) {
    const email = emailMessage({ purpose, code: '048213', expiresInMinutes: 10 });
    assert.ok(email.subject.startsWith('Your Bondfire'));
    assert.ok(email.text.includes('048213') && email.text.includes('10 minutes'));
    assert.ok(!/[<>]/.test(email.text), 'plain text, no markup');
    assert.ok(smsMessage({ purpose, code: '048213', expiresInMinutes: 10 }).includes('048213'));
  }
  // Different purposes say different things.
  assert.notEqual(
    emailMessage({ purpose: 'signup_email', code: '111111', expiresInMinutes: 10 }).text,
    emailMessage({ purpose: 'password_reset', code: '111111', expiresInMinutes: 10 }).text,
  );
});

test('a message refuses anything that is not a 6-digit code or a known purpose', () => {
  const ok = { purpose: 'signup_email', code: '123456', expiresInMinutes: 10 };
  for (const code of ['12345', '1234567', '12345a', '<b>1</b>', '123456\nBcc: x@y.z', 123456.5, undefined]) {
    assert.throws(() => emailMessage({ ...ok, code }), /6 digits/, String(code));
    assert.throws(() => smsMessage({ ...ok, code }), /6 digits/, String(code));
  }
  assert.throws(() => emailMessage({ ...ok, purpose: 'toString' }), /purpose/);
  assert.throws(() => emailMessage({ ...ok, purpose: 'newsletter' }), /purpose/);
  assert.throws(() => emailMessage({ ...ok, expiresInMinutes: 0 }), /expiresInMinutes/);
});

// ---------------------------------------------------------------------------
// Console provider
// ---------------------------------------------------------------------------

test('the console provider logs the masked destination and never the code', async () => {
  const { lines, logger } = captureLogger();
  const provider = createConsoleEmailProvider({ logger });
  await provider.send({ to: 'amelia.jane@example.com', purpose: 'signup_email', code: '482915', expiresInMinutes: 10 });
  await createConsoleSmsProvider({ logger }).send({ to: '+14155550123', purpose: 'phone_verification', code: '735019', expiresInMinutes: 10 });
  const output = lines.join('');
  assert.match(output, /a•••••e@example\.com/);
  assert.match(output, /0123/);
  assert.ok(!output.includes('482915') && !output.includes('735019'), 'the code was logged');
  assert.ok(!output.includes('amelia.jane'), 'the full address was logged');
  assert.ok(!output.includes('4155550'), 'the full number was logged');
});

test('the console provider prints the code only when asked to (LOG_CODES_IN_DEV in development)', async () => {
  const { lines, logger } = captureLogger();
  await createConsoleEmailProvider({ logger, logCodes: true })
    .send({ to: 'amelia.jane@example.com', purpose: 'signup_email', code: '482915', expiresInMinutes: 10 });
  assert.ok(lines.join('').includes('482915'));
});

// ---------------------------------------------------------------------------
// Memory providers
// ---------------------------------------------------------------------------

test('the memory providers record sends, can fail once, and can be cleared', async () => {
  const email = createMemoryEmailProvider();
  const sms = createMemorySmsProvider();
  assert.equal(email.channel, 'email');
  assert.equal(sms.channel, 'sms');
  await email.send({ to: 'a@b.co', purpose: 'signup_email', code: '111111', expiresInMinutes: 10 });
  await email.send({ to: 'a@b.co', purpose: 'signup_email', code: '222222', expiresInMinutes: 10 });
  assert.equal(email.sent.length, 2);
  assert.equal(email.lastCodeFor('a@b.co'), '222222');
  assert.equal(email.lastCodeFor('nobody@b.co'), undefined);
  assert.equal(sms.sent.length, 0);

  email.failNext(new Error('boom'));
  await assert.rejects(email.send({ to: 'a@b.co', purpose: 'signup_email', code: '333333', expiresInMinutes: 10 }), /boom/);
  await email.send({ to: 'a@b.co', purpose: 'signup_email', code: '444444', expiresInMinutes: 10 });
  assert.equal(email.lastCodeFor('a@b.co'), '444444');
  email.clear();
  assert.equal(email.sent.length, 0);
});

// ---------------------------------------------------------------------------
// SMTP provider (with a fake transport: no network)
// ---------------------------------------------------------------------------

const SMTP = { host: 'smtp.example.com', port: 587, secure: false, from: 'Bondfire <no-reply@example.com>' };

test('the smtp provider sends one plain-text message from the template', async () => {
  const mails = [];
  const provider = createSmtpEmailProvider({ smtp: SMTP, transport: { sendMail: async (mail) => { mails.push(mail); } } });
  await provider.send({ to: 'amelia.jane@example.com', purpose: 'password_reset', code: '048213', expiresInMinutes: 10 });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].from, SMTP.from);
  assert.equal(mails[0].to, 'amelia.jane@example.com');
  assert.equal(mails[0].subject, 'Your Bondfire password reset code');
  assert.ok(mails[0].text.includes('048213'));
  assert.equal(mails[0].html, undefined, 'plain text only');
});

test('the smtp provider refuses a recipient that is not one plain address', async () => {
  let sendMailCalled = false;
  const provider = createSmtpEmailProvider({ smtp: SMTP, transport: { sendMail: async () => { sendMailCalled = true; } } });
  for (const to of [
    'a@b.co\r\nBcc: victim@example.com', 'a@b.co, c@d.co', 'Name <a@b.co>', 'nobody', '', undefined,
    'a@b.com:x@y.z', 'a@b.com(evil@x.com)', 'a@b.com;x@y.z', 'a@b.com x@y.z', '"a@b.com"@x.com', 'a%b@x.com', 'a!b@x.com',
  ]) {
    await assert.rejects(provider.send({ to, purpose: 'signup_email', code: '123456', expiresInMinutes: 10 }), /recipient/, JSON.stringify(to));
  }
  assert.equal(sendMailCalled, false);
});

test('the smtp provider passes a transport failure on', async () => {
  const provider = createSmtpEmailProvider({ smtp: SMTP, transport: { sendMail: async () => { throw new Error('connection refused'); } } });
  await assert.rejects(provider.send({ to: 'a@b.co', purpose: 'signup_email', code: '123456', expiresInMinutes: 10 }), /connection refused/);
});

test('smtp connection settings: TLS from the start on 465, otherwise STARTTLS is required when asked for', () => {
  const plain = { ...SMTP, user: 'u', pass: 'p' };
  const required = smtpTransportOptions({ smtp: plain, requireTLS: true });
  assert.equal(required.requireTLS, true);
  assert.equal(required.secure, false);
  assert.deepEqual(required.auth, { user: 'u', pass: 'p' });
  assert.ok(required.connectionTimeout > 0 && required.socketTimeout > 0);
  // Not asked for (development): opportunistic, so a local mail catcher works.
  assert.equal(smtpTransportOptions({ smtp: plain }).requireTLS, false);
  // Port 465 is already encrypted: secure is on and STARTTLS is not needed on top.
  const implicit = smtpTransportOptions({ smtp: { ...plain, port: 465, secure: true }, requireTLS: true });
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTLS, false);
  assert.equal(smtpTransportOptions({ smtp: SMTP }).auth, undefined);
});

test('the smtp provider can be built without connecting', () => {
  const provider = createSmtpEmailProvider({ smtp: { ...SMTP, user: 'u', pass: 'p' }, requireTLS: true });
  assert.equal(provider.name, 'smtp');
});

// ---------------------------------------------------------------------------
// Choosing a provider from config
// ---------------------------------------------------------------------------

test('config picks the provider', () => {
  const { logger } = captureLogger();
  assert.equal(createEmailProvider({ config: loadConfig({ NODE_ENV: 'test' }), logger }).name, 'console');
  assert.equal(createSmsProvider({ config: loadConfig({ NODE_ENV: 'test' }), logger }).name, 'console');
  const smtp = loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'no-reply@example.com' });
  assert.equal(createEmailProvider({ config: smtp, logger }).name, 'smtp');
  assert.throws(() => createEmailProvider({ config: { email: { provider: 'carrier-pigeon' }, codes: {} }, logger }), /Unknown email provider/);
  // The console provider is only built in development and test, even from a config that was never validated.
  for (const env of ['staging', 'production', 'prod', 'Production']) {
    assert.throws(() => createEmailProvider({ config: { env, email: { provider: 'console' }, codes: {} }, logger }), /development and test/, env);
  }
  for (const env of ['development', 'test']) {
    assert.equal(createEmailProvider({ config: { env, email: { provider: 'console' }, codes: {} }, logger }).name, 'console');
  }
  // The real provider is encrypted exactly where config says TLS is required.
  const smtpConfig = (env, requireTls) => ({
    env, email: { provider: 'smtp', smtp: { host: 'smtp.example.com', port: 587, secure: false, requireTls, from: 'no-reply@example.com' } }, codes: {},
  });
  assert.equal(createEmailProvider({ config: smtpConfig('staging', true), logger }).encrypted, true);
  assert.equal(createEmailProvider({ config: smtpConfig('production', true), logger }).encrypted, true);
  assert.equal(createEmailProvider({ config: smtpConfig('development', false), logger }).encrypted, false);
  assert.equal(createEmailProvider({ config: loadConfig({ NODE_ENV: 'test', EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'no-reply@example.com', SMTP_PORT: '465' }), logger }).encrypted, true);
  assert.throws(() => createSmsProvider({ config: { sms: { provider: 'carrier-pigeon' }, codes: {} }, logger }), /Unknown SMS provider/);
});

test('the console provider from config prints codes only in development with LOG_CODES_IN_DEV', async () => {
  const cases = [
    [{ NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y', LOG_CODES_IN_DEV: 'true' }, true],
    [{ NODE_ENV: 'development', MONGODB_URI: 'mongodb://x/y' }, false],
    [{ NODE_ENV: 'test', LOG_CODES_IN_DEV: 'true' }, false],
  ];
  for (const [env, expected] of cases) {
    const { lines, logger } = captureLogger();
    const provider = createEmailProvider({ config: loadConfig(env), logger });
    await provider.send({ to: 'a@b.co', purpose: 'signup_email', code: '482915', expiresInMinutes: 10 });
    assert.equal(lines.join('').includes('482915'), expected, JSON.stringify(env));
  }
});

// ---------------------------------------------------------------------------
// Problem `meta`
// ---------------------------------------------------------------------------

test('a problem carries meta and retryAfterSeconds when the error has them', () => {
  const sent = {};
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { sent.status = code; return this; },
    type(value) { sent.type = value; return this; },
    send(body) { sent.body = JSON.parse(body); },
  };
  const req = { id: 'req-1', originalUrl: '/v1/auth/challenges/x/verify?debug=1' };
  sendProblem(req, res, new ApiError({
    status: 422, code: 'CODE_INCORRECT', title: "That code isn't right", meta: { attemptsRemaining: 3 },
  }));
  assert.equal(sent.status, 422);
  assert.deepEqual(sent.body.meta, { attemptsRemaining: 3 });
  assert.equal(sent.body.instance, '/v1/auth/challenges/x/verify');

  sendProblem(req, res, new ApiError({ status: 423, code: 'CHALLENGE_LOCKED', title: 'Locked', retryAfterSeconds: 12 }));
  assert.equal(sent.body.meta, undefined);
  assert.equal(sent.body.retryAfterSeconds, 12);
  assert.equal(res.headers['Retry-After'], '12');
});
