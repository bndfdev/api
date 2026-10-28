const fs = require('node:fs');
const yaml = require('js-yaml');
const { SPEC_PATH } = require('../middleware/validate');

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
let table;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toRegex(template) {
  const pattern = template.split(/\{[^}]+\}/).map(escapeRegex).join('[^/]+');
  return new RegExp(`^${pattern}/?$`);
}

function load() {
  const spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
  return Object.entries(spec.paths || {}).map(([template, item]) => ({
    regex: toRegex(template),
    methods: HTTP_METHODS.filter((m) => item[m]).map((m) => m.toUpperCase()),
  }));
}

/**
 * Methods the spec documents for a path (relative to the /v1 base, e.g.
 * `/auth/login`), for the `Allow` header of a 405. HEAD is added with GET, as
 * Express answers it. Returns undefined when the path is not documented.
 * @param {string} specPath
 */
function allowedMethods(specPath) {
  table ||= load();
  const entry = table.find((row) => row.regex.test(specPath));
  if (!entry) return undefined;
  const methods = new Set(entry.methods);
  if (methods.has('GET')) methods.add('HEAD');
  return [...methods].join(', ');
}

module.exports = { allowedMethods };
