/**
 * Test provider: records every send so a test can read the code it would have
 * received. Never selected from config; tests create one and inject it.
 */

/** @param {'email' | 'sms'} channel */
function createMemoryProvider(channel) {
  const sent = [];
  let failure = null;
  return {
    name: 'memory',
    channel,
    /** Every send, oldest first: `{to, purpose, code, expiresInMinutes}`. */
    sent,
    async send(message) {
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      sent.push({ ...message });
    },
    /** The next send throws `error` (once). */
    failNext(error = new Error('provider is down')) {
      failure = error;
    },
    /** The code most recently sent to `to`, or undefined. */
    lastCodeFor(to) {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        if (sent[i].to === to) return sent[i].code;
      }
      return undefined;
    },
    clear() {
      sent.length = 0;
      failure = null;
    },
  };
}

module.exports = { createMemoryProvider };
