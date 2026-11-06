/**
 * The live legal documents (GET /v1/legal/{type}, GET /v1/config → legal).
 *
 * Publishing a new version: change `version` (a date, YYYY-MM-DD), `effectiveAt` and the text here, in a
 * reviewed PR. Every account whose accepted terms version is older then sees the Terms screen again
 * (`consents.termsUpToDate: false`). The full text lives at `url`.
 *
 * PLACEHOLDER: the summary is the Figma placeholder copy and the URLs are not real yet. The real terms and
 * privacy policy, and where they are hosted, are still to be decided (docs/api README, open question 8).
 */
module.exports = Object.freeze({
  terms: Object.freeze({
    version: '2026-09-01',
    title: 'Terms and Conditions',
    summary: 'This is the written excerpt that outlines the terms and conditions',
    url: 'https://example.com/bondfire/legal/terms',
    effectiveAt: '2026-09-01T00:00:00Z',
    // Accepted on the Terms screen (Figma 1270:11938).
    requiresAcceptance: true,
  }),
  privacy: Object.freeze({
    version: '2026-09-01',
    title: 'Privacy Policy',
    summary: 'How Bondfire collects, uses and protects your personal information.',
    url: 'https://example.com/bondfire/legal/privacy',
    effectiveAt: '2026-09-01T00:00:00Z',
    // Acknowledged (the phone screen links to it), not separately accepted.
    requiresAcceptance: false,
  }),
});
