import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the public route preserves the existing authenticated app and install target', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!vercel.rewrites.some((r) => r.source === '/'), '/ must keep serving the app until the landing page is promoted');
  assert.equal(manifest.start_url, '/index.html');
  assert.equal(manifest.scope, '/');
  assert.match(read('app.js'), /redirectTo: window.location.origin \+ '\/index.html'/);
  assert.match(read('app.js'), /emailRedirectTo: window.location.origin \+ '\/index.html'/);
});

test('all media slots have matching server-side validation and schema', () => {
  const admin = read('admin/admin.js');
  const api = read('api/admin.js');
  const schema = read('sql/032_landing_media.sql');
  for (const slot of ['hero_background', 'hero_overlay', 'objective_background', 'objective_overlay',
    'conversation_background', 'conversation_overlay', 'call_screenshots', 'voice_orb', 'feature_media', 'demo_video']) {
    assert.ok(admin.includes(`'${slot}'`) && api.includes(`'${slot}'`) && schema.includes(`'${slot}'`), `missing ${slot}`);
  }
  assert.match(api, /requireAdmin\(req, supabase\)/);
  assert.match(api, /createSignedUploadUrl\(path\)/);
  assert.match(schema, /row level security/);
});

test('media renders as separate background and overlay layers with mobile sizing', () => {
  const html = read('landing.html');
  const css = read('landing.css');
  const js = read('landing.js');
  for (const key of ['hero', 'objective', 'conversation']) {
    assert.match(html, new RegExp(`data-background="${key}_background" data-overlay="${key}_overlay"`));
  }
  assert.match(js, /base\.replaceChildren\(img\)/);
  assert.match(js, /scene\.querySelector\('\.scene-overlay'\)\?\.replaceWith\(image\)/);
  assert.match(css, /\.scene-overlay\{position:absolute;z-index:2/);
  assert.match(css, /@media\(max-width:600px\)/);
  assert.match(css, /\.scene-overlay\.overlay-image\{width:min\(43%,235px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('introduction is the original audio/transcript and autoplay is opt-out after listening', () => {
  const html = read('landing.html');
  const js = read('landing.js');
  assert.match(html, /assets\/intro\/intro\.mp3/);
  assert.match(js, /assets\/intro\/intro\.json/);
  assert.match(js, /emysa_intro_seen/);
  assert.match(js, /emysa_landing_intro_attempted/);
  assert.match(js, /audio\.play\(\)/);
  assert.match(html, /type="range" id="audioSeek"/);
});
