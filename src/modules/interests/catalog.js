/**
 * The interest catalog: the one place that knows where interests come from (docs/api/components/schemas.yaml:
 * `Interest`). PROVISIONAL, until a dedicated `interests` collection exists: a replacement only has to give the
 * same four functions (`get`, `findByIds`, `featured`, `search`), and the service and routes stay as they are.
 *
 * Today the catalog is built from three existing collections, which are only ever READ here (never written):
 * - `genres` (models/Genre.js) gives kind `genre`, id `genre_<_id>`; popularity is the genre's `counter`;
 * - `artists` (models/Artist.js) gives kind `artist`, id `artist_<_id>`;
 * - `countries` (models/Country.js) gives kind `place`, id `place_<_id>`.
 * Inactive genres and artists (`active: false`) and disabled countries (`enabled: false`) are left out. The
 * other kinds (heritage, album, song, story, playlist, favorite) have no data yet and are never returned.
 *
 * Images: an artist or genre `image` becomes an `Image` with the URL the old API builds for it (an absolute
 * http(s) URL as it is, a file name under `<API_BASE_URL>/uploads/artists/` or `/uploads/genres/`). Their sizes
 * are not stored, so `width` and `height` are 0 (unknown). Without API_BASE_URL a file name has no URL, and the
 * image is null. Places have no image.
 *
 * The three collections are small and change rarely, so they are read once into memory and kept for `ttlMs`
 * (one minute); every request in that time works from the same snapshot.
 */
const Genre = require('../../../models/Genre');
const Artist = require('../../../models/Artist');
const Country = require('../../../models/Country');
const { config: defaultConfig } = require('../../config');

/** Kinds this catalog can return, in the order the featured grid mixes them. */
const KINDS = Object.freeze(['genre', 'artist', 'place']);
const ID = /^(genre|artist|place)_([0-9a-f]{24})$/;
/** How many of each kind the featured list holds (so at most 3 x 20 items). */
const FEATURED_PER_KIND = 20;
/**
 * The featured grid (Figma 1261:36247) repeats a block of 9 tiles: two small cards beside a large one, a row of
 * three small ones, then two small beside a large one. The large cards are the 3rd and the 9th of each 9.
 */
const LARGE_POSITIONS = Object.freeze([2, 8]);
const REGION = /^[A-Z]{2}$/;

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Text as search compares it: accents removed (an accented e is e), lower case, apostrophes dropped (straight,
 * curly and modifier ones: "Coastin" with a curly apostrophe is "coastin") and any other punctuation or symbol
 * read as a space.
 */
function fold(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2019\u02bc\u2018`\u00b4]/gu, '')
    .replace(/[\p{P}\p{S}\s]+/gu, ' ')
    .trim();
}

/** The words of a folded text. */
const wordsOf = (folded) => (folded === '' ? [] : folded.split(' '));

/** An `Image` for an old-API image value, or null. */
function imageOf(value, folder, baseUrl) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  let url;
  if (/^https?:\/\//i.test(raw)) {
    url = raw;
  } else if (baseUrl) {
    const file = raw.replace(new RegExp(`^/?uploads/?${folder}/?`), '').replace(/^\/+/, '');
    if (file === '') return null;
    url = `${baseUrl.replace(/\/+$/, '')}/uploads/${folder}/${file}`;
  } else {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { url: parsed.href, width: 0, height: 0, status: 'ready', blurhash: null };
  } catch {
    return null;
  }
}

/** Highest popularity first, then by title, then by id: the same order every time. */
const byPopularity = (a, b) => b.popularity - a.popularity || collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1);
const byTitle = (a, b) => collator.compare(a.title, b.title) || (a.id < b.id ? -1 : 1);
// ObjectIds only hold the second they were made; within it, a later one has the larger hex.
const byRecent = (a, b) => b.createdAt - a.createdAt || (a.sourceId < b.sourceId ? 1 : -1);

/**
 * How well an item matches the folded query words: 0 the whole title, 1 the start of the title, 2 every query
 * word starts a word of the title (any order); null for no match.
 */
function matchRank(item, query, queryWords) {
  if (item.folded === query) return 0;
  if (item.folded.startsWith(query)) return 1;
  return queryWords.every((q) => item.words.some((w) => w.startsWith(q))) ? 2 : null;
}

/**
 * @param {{config?: object, ttlMs?: number, now?: () => number}} [deps]
 */
function createCatalog({ config = defaultConfig, ttlMs = 60 * 1000, now = Date.now } = {}) {
  let snapshot = null;
  let loadedAt = 0;
  let loading = null;

  function itemOf(kind, doc, extra = {}) {
    const title = typeof doc.name === 'string' ? doc.name.trim() : '';
    if (title === '') return null;
    const folded = fold(title);
    return {
      id: `${kind}_${String(doc._id)}`,
      sourceId: String(doc._id),
      kind,
      title,
      subtitle: null,
      image: null,
      popularity: 0,
      createdAt: typeof doc._id.getTimestamp === 'function' ? doc._id.getTimestamp().getTime() : 0,
      folded,
      words: wordsOf(folded),
      ...extra,
    };
  }

  async function load() {
    const baseUrl = config.apiBaseUrl;
    const [genres, artists, countries] = await Promise.all([
      Genre.find({ active: { $ne: false } }).select('name image counter').lean(),
      Artist.find({ active: { $ne: false } }).select('name image').lean(),
      Country.find({ enabled: { $ne: false } }).select('name code').lean(),
    ]);
    const items = [
      ...genres.map((g) => itemOf('genre', g, {
        image: imageOf(g.image, 'genres', baseUrl),
        popularity: Number.isFinite(g.counter) ? g.counter : 0,
      })),
      ...artists.map((a) => itemOf('artist', a, { image: imageOf(a.image, 'artists', baseUrl) })),
      ...countries.map((c) => itemOf('place', c, {
        region: typeof c.code === 'string' && REGION.test(c.code.trim().toUpperCase()) ? c.code.trim().toUpperCase() : null,
      })),
    ].filter(Boolean);
    const byId = new Map(items.map((item) => [item.id, item]));
    const topByKind = Object.fromEntries(KINDS.map((kind) => [
      kind, items.filter((item) => item.kind === kind).sort(byPopularity),
    ]));
    return { items, byId, topByKind };
  }

  async function current() {
    // A clock that went back (an adjusted system clock) also reloads.
    const age = now() - loadedAt;
    if (snapshot && age >= 0 && age < ttlMs) return snapshot;
    loading ??= load().then((loaded) => {
      snapshot = loaded;
      loadedAt = now();
      return loaded;
    }).finally(() => { loading = null; });
    return loading;
  }

  /** The item with this id, or null (also for an id in no known format). */
  async function get(id) {
    if (!ID.test(String(id))) return null;
    return (await current()).byId.get(id) || null;
  }

  /** The items with these ids that exist, by id. */
  async function findByIds(ids) {
    const { byId } = await current();
    return new Map(ids.filter((id) => byId.has(id)).map((id) => [id, byId.get(id)]));
  }

  /**
   * The featured list, in its curated order: the kinds take turns (genre, artist, place, genre, ...), each
   * kind's items most popular first (then by title), at most FEATURED_PER_KIND of each; a kind that runs out
   * leaves the others to carry on. When `region` (the viewer's country) is a place in the catalog, it is the
   * first place. Every item carries `presentation.size` for the grid (see LARGE_POSITIONS).
   * @param {{region?: string | null, offset: number, limit: number}} input
   * @returns {Promise<{items: object[], hasMore: boolean}>}
   */
  async function featured({ region = null, offset, limit }) {
    const { topByKind } = await current();
    const lists = KINDS.map((kind) => {
      const all = topByKind[kind];
      const home = kind === 'place' && region ? all.find((item) => item.region === region) : null;
      return (home ? [home, ...all.filter((item) => item !== home)] : all).slice(0, FEATURED_PER_KIND);
    });
    const order = [];
    const longest = Math.max(...lists.map((list) => list.length));
    for (let i = 0; i < longest; i += 1) {
      for (const list of lists) if (i < list.length) order.push(list[i]);
    }
    const items = order.slice(offset, offset + limit).map((item, i) => ({
      ...item,
      presentation: { size: LARGE_POSITIONS.includes((offset + i) % 9) ? 'large' : 'small' },
    }));
    return { items, hasMore: offset + limit < order.length };
  }

  /**
   * Search. With query words, an item matches when every word starts a word of its title (accents, case and
   * punctuation ignored, see `fold`); without any, every item matches. `kinds` filters (empty: every kind).
   * Sorts: `relevance` (best match first, see `matchRank`, then popularity; with no query it is `popular`),
   * `popular`, `recent` (newest in the catalog first) and `alphabetical`.
   * @param {{query: string, kinds: string[], sort: string, offset: number, limit: number}} input
   *   `query` already trimmed
   * @returns {Promise<{items: object[], hasMore: boolean}>}
   */
  async function search({ query, kinds, sort, offset, limit }) {
    const { items } = await current();
    const folded = fold(query);
    const queryWords = wordsOf(folded);
    const ranked = [];
    for (const item of items) {
      if (kinds.length > 0 && !kinds.includes(item.kind)) continue;
      const rank = queryWords.length === 0 ? 0 : matchRank(item, folded, queryWords);
      if (rank !== null) ranked.push({ item, rank });
    }
    const relevance = (a, b) => a.rank - b.rank || byPopularity(a.item, b.item);
    const compare = {
      relevance,
      popular: (a, b) => byPopularity(a.item, b.item),
      recent: (a, b) => byRecent(a.item, b.item),
      alphabetical: (a, b) => byTitle(a.item, b.item),
    }[sort] || relevance;
    ranked.sort(compare);
    return { items: ranked.slice(offset, offset + limit).map((r) => r.item), hasMore: offset + limit < ranked.length };
  }

  return { get, findByIds, featured, search };
}

module.exports = { createCatalog, fold, imageOf, KINDS, FEATURED_PER_KIND, LARGE_POSITIONS, ...createCatalog() };
