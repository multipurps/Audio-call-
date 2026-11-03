// Phone numbers: the country code is its own field, it starts as the United States everywhere, and nothing
// defaults to Nigeria. The field always hands the rest of the app a full international number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COUNTRIES, DEFAULT_COUNTRY, countryByIso, countryForDigits, dialLabel, flag, nameForIso } from '../lib/countries.js';
import { composeE164, parseInternational, splitValue, searchCountries } from '../lib/phoneField.js';
import { normalizePhone } from '../lib/phoneNumbers.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('app.js');
const html = read('index.html');

test('the default country is the United States, and it leads the list', () => {
  assert.equal(DEFAULT_COUNTRY, 'US');
  assert.equal(COUNTRIES[0][0], 'US');
  assert.equal(nameForIso('US'), 'United States');
  assert.equal(flag('US'), '🇺🇸');
  assert.equal(dialLabel('US'), '+1');
  assert.equal(countryByIso('nonsense')[0], 'US', 'an unknown country falls back to the United States');
  assert.equal(countryByIso(undefined)[0], 'US');
});

test('the country table is complete and consistent', () => {
  assert.ok(COUNTRIES.length >= 230);
  assert.equal(new Set(COUNTRIES.map((c) => c[0])).size, COUNTRIES.length, 'no duplicate country codes');
  for (const [iso, name, dial] of COUNTRIES) {
    assert.match(iso, /^[A-Z]{2}$/);
    assert.ok(name.length > 1, iso);
    assert.match(dial, /^[1-9]\d{0,6}$/, `${iso} dial code`);
  }
  assert.equal(countryByIso('NG')[1], 'Nigeria');
  assert.equal(countryByIso('NG')[2], '234');
  assert.equal(dialLabel('JM'), '+1 876');
  assert.equal(dialLabel('NG'), '+234');
});

test('composeE164: US numbers, typed any way', () => {
  assert.equal(composeE164('US', '(415) 555-2671'), '+14155552671');
  assert.equal(composeE164('US', '415.555.2671'), '+14155552671');
  assert.equal(composeE164('US', '1 415 555 2671'), '+14155552671', 'the habitual leading 1 is dropped');
  assert.equal(composeE164('US', ''), '');
  assert.equal(composeE164('US', '   '), '');
  assert.equal(composeE164('US', '()-'), '');
});

test('composeE164: a national trunk 0 is dropped, except where it is part of the number', () => {
  assert.equal(composeE164('NG', '0803 123 4567'), '+2348031234567');
  assert.equal(composeE164('NG', '803 123 4567'), '+2348031234567');
  assert.equal(composeE164('GB', '07911 123456'), '+447911123456');
  assert.equal(composeE164('GH', '024 123 4567'), '+233241234567');
  assert.equal(composeE164('IT', '06 1234 5678'), '+390612345678', 'Italian numbers keep the 0');
  assert.equal(composeE164('CI', '07 12 34 56 78'), '+2250712345678', 'Ivory Coast numbers keep the 0');
  assert.equal(composeE164('JM', '555 0123'), '+18765550123', 'a +1 territory carries its area code in the dial code');
});

test('what the field produces is always a number the rest of the app accepts', () => {
  for (const [iso, typed, expected] of [['US', '4155552671', '+14155552671'], ['NG', '08031234567', '+2348031234567'], ['GB', '07911123456', '+447911123456'], ['IN', '98765 43210', '+919876543210']]) {
    assert.equal(normalizePhone(composeE164(iso, typed)), expected, `${iso} ${typed}`);
  }
  assert.equal(normalizePhone(composeE164('US', '12')), null, 'too short is still refused by the existing check');
  assert.equal(normalizePhone(composeE164('US', '')), null);
});

test('pasting or writing a full international number picks the right country', () => {
  assert.deepEqual({ ...parseInternational('+234 803 123 4567') }, { iso: 'NG', national: '8031234567' });
  assert.deepEqual({ ...parseInternational('00234 803 123 4567') }, { iso: 'NG', national: '8031234567' });
  assert.deepEqual({ ...parseInternational('+1 (415) 555-2671') }, { iso: 'US', national: '4155552671' });
  assert.deepEqual({ ...parseInternational('+44 7911 123456') }, { iso: 'GB', national: '7911123456' });
  assert.deepEqual({ ...parseInternational('+1 876 555 0123') }, { iso: 'JM', national: '5550123' });
  assert.deepEqual({ ...parseInternational('+7 916 123 4567') }, { iso: 'RU', national: '9161234567' });
  assert.equal(parseInternational('415 555 2671'), null, 'no plus, no guessing');
  assert.equal(parseInternational('08031234567'), null);
  assert.equal(parseInternational('+').iso, null);
});

test('stored numbers are split back into country and number, and a bare number stays on the United States', () => {
  assert.deepEqual({ ...splitValue('+2348031234567') }, { iso: 'NG', national: '8031234567' });
  assert.deepEqual({ ...splitValue('4155552671') }, { iso: 'US', national: '4155552671' });
  assert.deepEqual({ ...splitValue('') }, { iso: 'US', national: '' });
  assert.equal(countryForDigits('9999999999'), null);
});

test('the country search matches names, codes and dial codes', () => {
  assert.deepEqual(searchCountries('nige').map((c) => c[0]).sort(), ['NE', 'NG']);
  assert.ok(searchCountries('united').some((c) => c[0] === 'GB'));
  assert.ok(searchCountries('234').some((c) => c[0] === 'NG'));
  assert.ok(searchCountries('+44').some((c) => c[0] === 'GB'));
  assert.deepEqual(searchCountries('zzzz'), []);
  assert.equal(searchCountries('').length, COUNTRIES.length);
  assert.ok(searchCountries('gb').some((c) => c[0] === 'GB'));
});

test('every phone input in the app uses the country field', () => {
  const ids = ['lineNumInput', 'waNumInput', 'tgNumInput', 'newContactPhone', 'telegramPhoneInput', 'whatsappPhoneInput', 'dialNumber'];
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), `${id} exists in the page`);
  const phoneInputs = [...html.matchAll(/<input[^>]*type="tel"[^>]*>/g)].map((m) => (m[0].match(/id="([^"]+)"/) || [])[1]);
  assert.deepEqual([...phoneInputs].sort(), [...ids].sort(), 'no phone input exists that is not on the list');
  assert.match(app, /\['lineNumInput', 'waNumInput', 'tgNumInput', 'newContactPhone', 'telegramPhoneInput', 'whatsappPhoneInput'\]\.forEach\(\(id\) => mountPhoneField\(\$\(id\)\)\)/);
  assert.match(app, /mountPhoneField\(\$\('dialNumber'\), \{ big: true \}\)/);
});

test('nothing in the app defaults to Nigeria: no +234 examples, no language-based country guess', () => {
  assert.doesNotMatch(html, /\+234|2349\d{5}|Nigeria/);
  assert.doesNotMatch(app, /\+234|2349\d{5}|'NG'|"NG"/);
  for (const f of ['api/social-calling.js', 'api/assistant.js', 'api/calls.js', 'server-social/social-relay.js']) assert.doesNotMatch(read(f), /\+234|2349\d{5}/, f);
  assert.doesNotMatch(app, /navigator\.language[^\n]*split\('-'\)\[1\]/, 'the profile country is no longer guessed from the phone language');
  assert.match(app, /country\.value = 'US';/);
});

test('the country lists the app builds also start on the United States', () => {
  assert.match(app, /if \(\[\.\.\.sel\.options\]\.some\(\(o\) => o\.value === 'US'\)\) sel\.value = 'US';/);
  assert.match(app, /rentCountry'\)\.value \|\| 'US'/);
});

test('the field keeps the page contract: the input value is the full number and clearing resets to the US', () => {
  const src = read('lib/phoneField.js');
  assert.match(src, /Object\.defineProperty\(input, 'value'/);
  assert.match(src, /iso = DEFAULT_COUNTRY; typed = '';/);
  assert.match(src, /host: field\.closest\('dialog'\) \|\| undefined/, 'the picker opens inside a modal dialog when the field is in one');
  assert.match(read('lib/countries.js'), /export const DEFAULT_COUNTRY = 'US';/);
});
