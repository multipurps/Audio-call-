import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the public route preserves the existing authenticated app and install target', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const manifest = JSON.parse(read('manifest.json'));
  const root = vercel.routes.find((r) => r.src === '/');
  assert.equal(root.dest, '/home.html', '/ serves the public page');
  assert.ok(vercel.routes.findIndex((r) => r.src === '/') < vercel.routes.findIndex((r) => r.handle === 'filesystem'), '/ must be matched before the filesystem');
  assert.ok(!vercel.rewrites && !vercel.headers, 'routes cannot be combined with rewrites/headers');
  assert.match(read('home.html'), /standalone/);
  assert.match(read('home.html'), /replace\('\/index\.html'/);
  assert.equal(manifest.start_url, '/index.html');
  assert.equal(manifest.scope, '/');
  assert.match(read('app.js'), /redirectTo: window.location.origin \+ '\/index.html'/);
  assert.match(read('app.js'), /emailRedirectTo: window.location.origin \+ '\/index.html'/);
});

test('all media slots have matching server-side validation and schema', () => {
  const admin = read('admin/admin.js');
  const api = read('api/admin.js');
  const schema = read('sql/032_landing_media.sql') + read('sql/033_live_call_video.sql') + read('sql/035_landing_feature_slots.sql');
  for (const slot of ['hero_background', 'hero_overlay', 'objective_background', 'objective_overlay',
    'conversation_background', 'conversation_overlay', 'call_screenshots', 'voice_orb', 'feature_media', 'demo_video',
    'live_call_video', 'how_it_works', 'your_voice', 'call_summary', 'call_in_app', 'import_chats', 'channels', 'footer_background']) {
    assert.ok(admin.includes(`'${slot}'`) && api.includes(`'${slot}'`) && schema.includes(`'${slot}'`), `missing ${slot}`);
  }
  // Uploads stay admin-only: the role check must run before the action switch,
  // and the only action allowed ahead of it is the public read-only projection.
  assert.match(api, /getAdminAccess\(req, supabase\)/);
  const beforeGate = api.slice(0, api.indexOf('if (!access.role)'));
  assert.ok(beforeGate.length > 0, 'role gate missing');
  assert.ok(!/create-landing-upload|confirm-landing-upload/.test(beforeGate.split('export default async function handler')[1] || ''), 'upload actions must be behind the gate');
  assert.match(api, /createSignedUploadUrl\(path\)/);
  assert.match(schema, /row level security/);
});

test('feature phones render only real uploads, and videos pause when scrolled away', () => {
  const html = read('home.html');
  const js = read('landing.js');
  for (const slot of ['how_it_works', 'your_voice', 'live_call_video', 'call_summary', 'call_in_app', 'import_chats', 'channels'])
    assert.match(html, new RegExp(`data-slot="${slot}"`));
  assert.ok(!/class="mk|class="bub/.test(html), 'no placeholder mock content');
  assert.match(js, /IntersectionObserver[\s\S]*v\.play\(\)[\s\S]*v\.pause\(\)/);
  assert.match(html, /Octopusfur/);
});

test('hero is the login background with the typed introduction transcript', () => {
  const html = read('home.html');
  const js = read('landing.js');
  assert.match(js, /auth_backgrounds/);
  assert.match(html, /id="introLog"/);
  assert.match(js, /assets\/intro\/intro\.json/);
  assert.match(js, /audio\.play\(\)/);
});
