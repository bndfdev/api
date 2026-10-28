const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestEmail } = require('../src/lib/emailSuggestion');

test('a domain one typo away from a big provider gets a suggestion', () => {
  for (const [typed, fixed] of [
    ['amelia.jane@gmial.com', 'amelia.jane@gmail.com'], // swapped letters
    ['a@gmail.co', 'a@gmail.com'], // missing letter
    ['a@gmaill.com', 'a@gmail.com'], // extra letter
    ['a@yahoo.con', 'a@yahoo.com'], // wrong letter
    ['a@hotmial.com', 'a@hotmail.com'],
    ['a@outlok.com', 'a@outlook.com'],
    ['a@icloud.co', 'a@icloud.com'],
  ]) {
    assert.equal(suggestEmail(typed), fixed, typed);
  }
});

test('no suggestion for a correct provider, an unrelated domain or a short domain', () => {
  for (const email of ['a@gmail.com', 'a@example.com', 'a@company.in', 'a@aol.com', 'a@gmx.com', 'a@aol.co', 'nodomain', '@x']) {
    assert.equal(suggestEmail(email), null, email);
  }
});

test('only the domain changes; the part before the @ is kept as it is', () => {
  assert.equal(suggestEmail('first.last+news@gmial.com'), 'first.last+news@gmail.com');
});
