/**
 * What the app reads before anyone signs in (docs/api/paths/catalog.yaml: getConfig, listCountries).
 * No database: everything comes from config, the rule modules and libphonenumber-js.
 *
 * - GET /config is built from the same constants the server enforces (password policy, code timings,
 *   minimum age, languages, legal versions), so the app and the server can never disagree.
 * - GET /countries lists every region libphonenumber-js knows, with its dial code, flag, an example mobile
 *   number and localised name (Accept-Language), sorted by that name. `phoneSignupSupported` follows
 *   PHONE_REGIONS; `contentAvailable` follows CONTENT_REGIONS (left out when that is not set).
 */
const { getCountries, getCountryCallingCode, getExampleNumber } = require('libphonenumber-js/max');
const examples = require('libphonenumber-js/mobile/examples');
const { config: defaultConfig } = require('../../config');
const { PASSWORD_POLICY } = require('../../lib/passwords');
const { MINIMUM_AGE } = require('../../lib/dateOfBirth');
const { SUPPORTED_LANGUAGES } = require('../../lib/languages');
const { RULES: CODE_RULES } = require('../challenges/service');
const defaultLegal = require('../legal/service');

/** Limits the app shows before the server would refuse (photo uploads and interests use them in later PRs). */
const LIMITS = Object.freeze({ maxInterests: 100, avatarMaxBytes: 10 * 1024 * 1024, bannerMaxBytes: 10 * 1024 * 1024, nameMaxLength: 50 });
const REGION = /^[A-Z]{2}$/;
const MAX_CACHED_LOCALES = 50;

/** "🇮🇳" for "IN": the two regional-indicator letters. */
const flagOf = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/** The first language of an Accept-Language header that Intl knows, or 'en'. */
function localeFrom(header) {
  const first = typeof header === 'string' ? header.split(',')[0].split(';')[0].trim() : '';
  if (first && first !== '*') {
    try {
      return Intl.getCanonicalLocales(first)[0];
    } catch {
      // Not a language tag: fall back.
    }
  }
  return 'en';
}

/**
 * @param {{config?: object, legal?: object}} [deps]
 */
function createMetaService({ config = defaultConfig, legal = defaultLegal } = {}) {
  /** @returns {object} `AppConfig` */
  function appConfig() {
    const body = {
      minimumSupportedVersion: { ...config.app.minimumVersions },
      passwordPolicy: { ...PASSWORD_POLICY },
      otp: {
        length: CODE_RULES.codeLength,
        ttlSeconds: CODE_RULES.ttlSeconds,
        resendCooldownSeconds: CODE_RULES.resendCooldownSeconds,
        maxAttempts: CODE_RULES.maxAttempts,
      },
      minimumAge: MINIMUM_AGE,
      supportedLanguages: SUPPORTED_LANGUAGES.map((l) => ({ ...l })),
      legal: legal.currentVersions(),
      features: {
        guestMode: config.features.guestMode,
        phoneVerificationRequired: config.features.phoneVerificationRequired,
        // TODO(social login PR): switched on per provider once POST /auth/social exists.
        socialLogin: { apple: false, google: false, facebook: false },
      },
      limits: { ...LIMITS },
    };
    if (Object.keys(config.app.latestVersions).length > 0) body.latestVersion = { ...config.app.latestVersions };
    return body;
  }

  // The list for one locale never changes while the server runs, so it is built once per locale.
  const listsByLocale = new Map();

  function countriesFor(locale) {
    const cached = listsByLocale.get(locale);
    if (cached) return cached;
    const names = new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'code' });
    const collator = new Intl.Collator(locale);
    const regions = config.phone.regions;
    const content = config.countries.contentRegions;
    const list = getCountries().filter((code) => REGION.test(code)).map((code) => {
      const country = {
        code,
        name: names.of(code),
        dialCode: `+${getCountryCallingCode(code)}`,
        flagEmoji: flagOf(code),
        phoneSignupSupported: regions.length === 0 || regions.includes(code),
      };
      const example = getExampleNumber(code, examples);
      if (example) country.exampleNumber = example.formatNational();
      if (content.length > 0) country.contentAvailable = content.includes(code);
      return country;
    }).sort((a, b) => collator.compare(a.name, b.name));
    if (listsByLocale.size >= MAX_CACHED_LOCALES) listsByLocale.clear();
    listsByLocale.set(locale, list);
    return list;
  }

  /**
   * @param {{acceptLanguage?: string, viewerCountry?: string}} input `viewerCountry` is the two-letter country a
   *   CDN in front of the API says the request comes from, if any
   * @returns {object} `CountryList`
   */
  function countries({ acceptLanguage, viewerCountry } = {}) {
    const data = countriesFor(localeFrom(acceptLanguage));
    const guess = typeof viewerCountry === 'string' ? viewerCountry.trim().toUpperCase() : '';
    const known = REGION.test(guess) && data.some((c) => c.code === guess);
    return { data, defaultCountryCode: known ? guess : config.countries.defaultCountry };
  }

  return { appConfig, countries };
}

module.exports = { createMetaService, localeFrom, flagOf, LIMITS, ...createMetaService() };
