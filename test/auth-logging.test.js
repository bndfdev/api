const test = require('node:test');
const assert = require('node:assert/strict');

const authenticateToken = require('../middleware/auth');
const preLoginAuth = require('../middleware/preLoginAuth');
const VerificationToken = require('../models/VerificationToken');
const User = require('../models/User');
const userController = require('../controllers/userController');

const credential = 'test-credential-do-not-log';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function captureLogs(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const output = [];
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => output.push(args.join(' '));
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(output.some((line) => line.includes(credential)), false);
}

test('Bearer authentication preserves success and rejection without logging tokens', async () => {
  const originalFindOne = VerificationToken.findOne;
  try {
    VerificationToken.findOne = async ({ token }) => {
      assert.equal(token, credential);
      return { email: 'test@example.invalid', expires: new Date(Date.now() + 60_000) };
    };
    await captureLogs(async () => {
      const req = { headers: { authorization: `Bearer ${credential}` } };
      const res = response();
      let nextCalled = false;
      await authenticateToken(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(req.user.email, 'test@example.invalid');
      assert.equal(res.statusCode, 200);
    });

    VerificationToken.findOne = async () => null;
    await captureLogs(async () => {
      const res = response();
      await authenticateToken(
        { headers: { authorization: `Bearer ${credential}` } },
        res,
        () => assert.fail('invalid token must not call next'),
      );
      assert.equal(res.statusCode, 403);
    });

    await captureLogs(async () => {
      const res = response();
      await authenticateToken(
        { headers: {} },
        res,
        () => assert.fail('missing token must not call next'),
      );
      assert.equal(res.statusCode, 401);
    });

    VerificationToken.findOne = async () => { throw new Error(credential); };
    await captureLogs(async () => {
      const res = response();
      await authenticateToken(
        { headers: { authorization: `Bearer ${credential}` } },
        res,
        () => assert.fail('database failure must not call next'),
      );
      assert.equal(res.statusCode, 403);
    });
  } finally {
    VerificationToken.findOne = originalFindOne;
  }
});

test('body-token endpoints and pre-login rejection do not log credentials', async () => {
  const originalFindOne = VerificationToken.findOne;
  VerificationToken.findOne = async () => null;
  try {
    await captureLogs(async () => {
      const body = { verificationToken: credential };
      const artistsResponse = response();
      await userController.setArtists({ body: { ...body, artists: ['artist'] } }, artistsResponse);
      assert.equal(artistsResponse.statusCode, 401);

      const genderResponse = response();
      await userController.setGender({ body: { ...body, gender: 'other' } }, genderResponse);
      assert.equal(genderResponse.statusCode, 401);

      const nameResponse = response();
      await userController.updateName({ body: { ...body, name: 'Test' } }, nameResponse);
      assert.equal(nameResponse.statusCode, 401);

      const avatarResponse = response();
      await userController.uploadAvatar({ body }, avatarResponse);
      assert.equal(avatarResponse.statusCode, 400);

      const bannerResponse = response();
      await userController.uploadBanner({ body }, bannerResponse);
      assert.equal(bannerResponse.statusCode, 400);

      const res = response();
      preLoginAuth(
        { header: () => credential },
        res,
        () => assert.fail('invalid API key must not call next'),
      );
      assert.equal(res.statusCode, 401);
    });
  } finally {
    VerificationToken.findOne = originalFindOne;
  }
});

test('profile endpoints do not log valid tokens or user documents', async () => {
  const originalTokenFindOne = VerificationToken.findOne;
  const originalUserFindOne = User.findOne;
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  VerificationToken.findOne = async () => ({
    email: 'test@example.invalid',
    expires: new Date(Date.now() + 60_000),
  });
  User.findOneAndUpdate = async () => ({
    email: 'test@example.invalid',
    password: credential,
    gender: 'other',
  });
  User.findOne = async () => null;
  try {
    await captureLogs(async () => {
      const genderResponse = response();
      await userController.setGender(
        { body: { verificationToken: credential, gender: 'other' } },
        genderResponse,
      );
      assert.equal(genderResponse.statusCode, 200);

      const req = {
        body: { verificationToken: credential },
        file: { filename: 'test-image.png', mimetype: 'image/png', size: 10 },
      };
      const avatarResponse = response();
      await userController.uploadAvatar(req, avatarResponse);
      assert.equal(avatarResponse.statusCode, 404);

      const bannerResponse = response();
      await userController.uploadBanner(req, bannerResponse);
      assert.equal(bannerResponse.statusCode, 404);
    });
  } finally {
    VerificationToken.findOne = originalTokenFindOne;
    User.findOne = originalUserFindOne;
    User.findOneAndUpdate = originalFindOneAndUpdate;
  }
});
