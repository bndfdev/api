/**
 * Legal documents and consents (docs/api: getLegalDocument, listConsents, acceptLegalDocument, and the
 * `consents` part of `User`). The rules only: no HTTP; the documents come from content/legal.js and the
 * consent records from the repo.
 *
 * - Only the live version of a document can be accepted; an older one is LEGAL_VERSION_OUTDATED (409, with
 *   the current version), so the app reloads the text and asks again.
 * - Accepting the same version twice returns the first record.
 * - An account is "up to date" with a document when it accepted the live version, or when the document does
 *   not need accepting (`requiresAcceptance: false`).
 */
const { ApiError } = require('../../lib/problem');
const { iso } = require('../../lib/time');
const defaultDocuments = require('../../../content/legal');
const defaultRepo = require('./repo');

const TYPES = Object.freeze(['terms', 'privacy']);

const documentNotFound = () => new ApiError({
  status: 404, code: 'LEGAL_DOCUMENT_NOT_FOUND', title: 'Document not found',
});
const versionOutdated = (currentVersion) => new ApiError({
  status: 409, code: 'LEGAL_VERSION_OUTDATED', title: 'A newer version is live',
  detail: 'This document has been updated. Read the new version and accept it again.',
  meta: { currentVersion },
});

/** `Consent` from docs/api. */
const toConsent = (c) => ({ documentType: c.documentType, version: c.version, acceptedAt: iso(c.acceptedAt) });

/**
 * @param {{documents?: object, repo?: object, now?: () => number}} [deps]
 */
function createLegalService({ documents = defaultDocuments, repo = defaultRepo, now = Date.now } = {}) {
  function live(type) {
    return TYPES.includes(type) && documents[type] ? documents[type] : null;
  }

  /** @returns {object} `LegalDocument` */
  function getDocument(type) {
    const doc = live(type);
    if (!doc) throw documentNotFound();
    return {
      type,
      version: doc.version,
      title: doc.title,
      summary: doc.summary,
      url: doc.url,
      effectiveAt: doc.effectiveAt,
      requiresAcceptance: doc.requiresAcceptance === true,
    };
  }

  /** `{termsVersion, privacyVersion}` for GET /config. */
  function currentVersions() {
    return { termsVersion: live('terms').version, privacyVersion: live('privacy').version };
  }

  /**
   * Record that the account accepted a document version.
   * @param {{userId: string, accountType: 'user' | 'guest', documentType: string, version: string, ip?: string, installationId?: string}} input
   * @returns {Promise<{consent: object, created: boolean}>} `consent` is the spec's `Consent`
   */
  async function accept({ userId, accountType, documentType, version, ip, installationId }) {
    const doc = live(documentType);
    if (!doc) throw documentNotFound();
    if (version !== doc.version) throw versionOutdated(doc.version);
    const { consent, created } = await repo.record({
      userId, accountType, documentType, version, acceptedAt: new Date(Math.floor(now() / 1000) * 1000), ip, installationId,
    });
    return { consent: toConsent(consent), created };
  }

  /** @returns {Promise<object>} `ConsentList`, newest first */
  async function list(userId) {
    return { data: (await repo.list(userId)).map(toConsent) };
  }

  /**
   * The `consents` part of `User` (the spec's `ConsentStatus`).
   * @returns {Promise<{termsAcceptedVersion: string | null, termsUpToDate: boolean, privacyAcceptedVersion: string | null, privacyUpToDate: boolean}>}
   */
  async function statusFor(userId) {
    const records = await repo.list(userId);
    const latest = (type) => {
      const found = records.find((r) => r.documentType === type);
      return found ? found.version : null;
    };
    const upToDate = (type) => {
      const doc = live(type);
      return !doc.requiresAcceptance || records.some((r) => r.documentType === type && r.version === doc.version);
    };
    return {
      termsAcceptedVersion: latest('terms'),
      termsUpToDate: upToDate('terms'),
      privacyAcceptedVersion: latest('privacy'),
      privacyUpToDate: upToDate('privacy'),
    };
  }

  /** Move a guest's consents to the account it became at sign-up. */
  function moveToAccount(guestId, userId) {
    return repo.moveToAccount(guestId, userId);
  }

  return { getDocument, currentVersions, accept, list, statusFor, moveToAccount };
}

module.exports = { createLegalService, ...createLegalService() };
