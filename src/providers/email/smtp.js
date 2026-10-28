/**
 * Sends codes by email through an SMTP server (config: SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS, SMTP_FROM). Plain-text message from a fixed template.
 * Any failure is thrown; the challenge service turns it into EMAIL_DELIVERY_FAILED.
 */
const nodemailer = require('nodemailer');
const { isValidEmail } = require('../../lib/destination');
const { emailMessage } = require('../messages');

const TIMEOUT_MS = 10000;

/**
 * The nodemailer connection settings. With `requireTLS` the message is never
 * sent over a connection that cannot be encrypted: TLS from the start on port
 * 465 (`secure`), otherwise STARTTLS is required.
 * @param {{smtp: {host: string, port: number, secure: boolean, user?: string, pass?: string}, requireTLS?: boolean}} options
 */
function smtpTransportOptions({ smtp, requireTLS = false }) {
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: requireTLS && !smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  };
}

/**
 * @param {{smtp: {host: string, port: number, secure: boolean, user?: string, pass?: string, from: string},
 *   requireTLS?: boolean, transport?: {sendMail: Function}}} options
 *   `transport` replaces the real connection (tests).
 */
function createSmtpEmailProvider({ smtp, requireTLS = false, transport }) {
  const options = smtpTransportOptions({ smtp, requireTLS });
  const mailer = transport || nodemailer.createTransport(options);
  return {
    name: 'smtp',
    /** Whether messages only ever travel over an encrypted connection. */
    encrypted: options.secure || options.requireTLS,
    async send({ to, purpose, code, expiresInMinutes }) {
      // One plain address, exactly as the service validated it (this also keeps line breaks and extra recipients out of the headers).
      if (!isValidEmail(to)) throw new Error('Invalid recipient');
      const { subject, text } = emailMessage({ purpose, code, expiresInMinutes });
      await mailer.sendMail({ from: smtp.from, to, subject, text });
    },
  };
}

module.exports = { createSmtpEmailProvider, smtpTransportOptions };
