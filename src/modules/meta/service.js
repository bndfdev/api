/**
 * What the app reads before anyone signs in (docs/api/paths/catalog.yaml: getConfig, listCountries).
 * No database: everything comes from config, the rule modules and libphonenumber-js.
 *
 * - GET /config is built from the same constants the server enforces (password policy, code timings,
 *   minimum age, languages, legal versions, name length), so the app and the server can never disagree.
 * - GET /countries lists every region libphonenumber-js knows, with its dial code, flag, an example mobile
 *   number and name in the app language Accept-Language prefers, sorted by that name. `phoneSignupSupported` follows
 *   PHONE_REGIONS; `contentAvailable` follows CONTENT_REGIONS (left out when that is not set).
 */
const { getCountries, getCountryCallingCode, getExampleNumber } = require('libphonenumber-js/max');
const examples = require('libphonenumber-js/mobile/examples');
const { config: defaultConfig } = require('../../config');
const { PASSWORD_POLICY } = require('../../lib/passwords');
const { MINIMUM_AGE } = require('../../lib/dateOfBirth');
const { SUPPORTED_LANGUAGES } = require('../../lib/languages');
const { NAME_MAX_LENGTH } = require('../users/service');
const { RULES: CODE_RULES } = require('../challenges/service');
const defaultLegal = require('../legal/service');

/**
 * Limits the app shows before the server would refuse. The name limit is enforced now; the interest and photo
 * limits are enforced by the interests and photo-upload PRs.
 */
const LIMITS = Object.freeze({ maxInterests: 100, avatarMaxBytes: 10 * 1024 * 1024, bannerMaxBytes: 10 * 1024 * 1024, nameMaxLength: NAME_MAX_LENGTH });
const REGION = /^[A-Z]{2}$/;
const LANGUAGE_TAGS = SUPPORTED_LANGUAGES.map((l) => l.tag);

/** "🇮🇳" for "IN": the two regional-indicator letters. */
const flagOf = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/**
 * The app language (GET /config's `supportedLanguages`) that an Accept-Language header prefers most, by q-value,
 * a regional tag matching its language ("fr-CA" gives "fr"); 'en' when none fits. Only these few lists are ever
 * built, so unusual headers cannot fill the cache.
 */
function localeFrom(header) {
  const ranges = (typeof header === 'string' ? header.split(',') : []).map((part, index) => {
    const [tag, ...params] = part.split(';');
    const q = params.map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/i.exec(p)).find(Boolean);
    return { tag: tag.trim().toLowerCase(), q: q ? Number(q[1]) : 1, index };
  }).filter((r) => r.tag !== '' && r.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranges) {
    const match = LANGUAGE_TAGS.find((code) => tag === code || tag.startsWith(`${code}-`));
    if (match) return match;
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

  // The list for one language never changes while the server runs, so it is built once per language.
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
