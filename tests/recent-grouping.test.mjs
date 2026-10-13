import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('function personKeyForCall'), src.indexOf('let recentSelecting'));
const personKeyForCall = new Function(`${body}; return personKeyForCall;`)();

test('calls to Emysa with no number or contact id collapse into one person', () => {
  const a = personKeyForCall({ id: '1', contact_name: 'Emysa', to_number: null });
  const b = personKeyForCall({ id: '2', contact_name: ' emysa ', to_number: '' });
  assert.equal(a, b);
});

test('the real shape: contact_name empty and to_number is the text "Emysa"', () => {
  assert.equal(
    personKeyForCall({ id: '1', contact_name: null, to_number: 'Emysa' }),
    personKeyForCall({ id: '2', contact_name: null, to_number: 'emysa ' }),
  );
});

test('number beats contact id beats name beats call id; different people stay apart', () => {
  assert.equal(personKeyForCall({ id: '1', to_number: '+234 907 437 683' }), personKeyForCall({ id: '2', to_number: '234907437683' }));
  assert.equal(personKeyForCall({ id: '1', contact_id: 'c1', contact_name: 'A' }), 'c:c1');
  assert.notEqual(personKeyForCall({ id: '1', contact_name: 'Emysa' }), personKeyForCall({ id: '2', contact_name: 'Victor' }));
  assert.equal(personKeyForCall({ id: '9' }), 'i:9');
});

test('Recent top row and select bar clear the notch, and the select button sits left of the search bar', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(css, /#screen-recent \.recentTopRow\{[^}]*var\(--safe-top\)/);
  assert.match(css, /#screen-recent \.recentSelectBar\{[^}]*var\(--safe-top\)/);
  assert.match(css, /#screen-recent \.recentTopRow \.searchBar\{[^}]*margin:0/);
  assert.ok(html.indexOf('id="recentSelectBtn"') < html.indexOf('id="recentSearch"'));
});
