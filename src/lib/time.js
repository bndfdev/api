/** RFC 3339 UTC without milliseconds (`Timestamp` in docs/api). */
const iso = (date) => new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');

module.exports = { iso };
