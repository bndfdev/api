/**
 * The fixed text of the messages that carry a one-time code. Nothing a user
 * typed is ever put into a message: the only variable parts are the code
 * (6 digits, checked here) and the number of minutes it stays valid.
 * Plain text only, so there is no markup to inject into.
 */

const INTRO = Object.freeze({
  signup_email: 'Use this code to finish creating your Bondfire account.',
  password_reset: 'Use this code to reset your Bondfire password.',
  phone_verification: 'Use this code to verify your phone number on Bondfire.',
});

const EMAIL_SUBJECT = Object.freeze({
  signup_email: 'Your Bondfire verification code',
  password_reset: 'Your Bondfire password reset code',
  phone_verification: 'Your Bondfire verification code',
});

const CODE_PATTERN = /^[0-9]{6}$/;

function check({ purpose, code, expiresInMinutes }) {
  if (!Object.hasOwn(INTRO, purpose)) throw new Error('Unknown code purpose');
  if (!CODE_PATTERN.test(String(code))) throw new Error('A code is exactly 6 digits');
  if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 1) throw new Error('expiresInMinutes must be a positive integer');
}

/** @returns {{subject: string, text: string}} */
function emailMessage(input) {
  check(input);
  const { purpose, code, expiresInMinutes } = input;
  return {
    subject: EMAIL_SUBJECT[purpose],
    text: [
      INTRO[purpose],
      '',
      `Your code: ${code}`,
      '',
      `It expires in ${expiresInMinutes} minutes. If you did not ask for it, you can ignore this email.`,
    ].join('\n'),
  };
}

// Account notices: emails that carry no code. Fixed text only, like the code messages.
const NOTICES = Object.freeze({
  password_changed: {
    subject: 'Your Bondfire password was changed',
    text: [
      'The password for your Bondfire account was just changed, and every device was signed out.',
      '',
      'If this was you, there is nothing else to do.',
      'If it was not, reset your password straight away from the app ("Reset password" on the sign-in screen).',
    ].join('\n'),
  },
});

/** @param {string} notice a key of NOTICES @returns {{subject: string, text: string}} */
function noticeEmail(notice) {
  if (!Object.hasOwn(NOTICES, notice)) throw new Error('Unknown notice');
  return { ...NOTICES[notice] };
}

/** @returns {string} */
function smsMessage(input) {
  check(input);
  return `Bondfire: your code is ${input.code}. It expires in ${input.expiresInMinutes} minutes.`;
}

module.exports = { emailMessage, noticeEmail, smsMessage, NOTICES };
