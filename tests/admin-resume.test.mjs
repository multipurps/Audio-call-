// Admin panel: minimizing and coming back must keep the person where they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const admin = readFileSync(new URL('../admin/admin.js', import.meta.url), 'utf8');

test('a repeated sign-in event for the user already in the panel does not restart it', () => {
  const handler = admin.slice(admin.indexOf('supabase.auth.onAuthStateChange'), admin.indexOf('let myRole'));
  assert.match(handler, /alreadyInPanel\(session\)\) return;/);
  assert.match(admin, /enteredFor === session\.user\.id/);
  assert.match(admin, /if \(!alreadyInPanel\(data\.session\)\) enterAdmin\(\)/);
});

test('signing out or losing admin access clears the remembered user', () => {
  assert.match(admin, /else \{ enteredFor = null; showSignInForm\(\); \}/);
  assert.match(admin, /function showNotAdmin\(access\) \{\n  enteredFor = null;/);
});

test('the open section is remembered and restored, and Admins only for the owner', () => {
  assert.match(admin, /localStorage\.setItem\(SECTION_KEY, name\)/);
  const init = admin.slice(admin.indexOf('function initPanel'), admin.indexOf('function initPanel') + 1500);
  assert.match(init, /saved && canOpen\(saved\) \? saved : 'overview'/);
  assert.match(admin, /const canOpen = \(name\) => Boolean\(loaders\[name\]\) && \(myRole === 'owner' \|\| INVESTOR_SECTIONS\.includes\(name\)\)/);
  assert.doesNotMatch(init, /openSection\('overview'\);\n\}/);
});
