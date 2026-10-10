// Static Vercel deployment: no bundler. Fail fast if a shipped reference is absent.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
if (vercel.rewrites[0]?.destination !== '/landing.html' || manifest.start_url !== '/index.html') throw Error('Landing/app route mismatch');
for (const path of ['landing.html','landing.css','landing.js','index.html','admin/index.html','sw.js','manifest.json','apple-touch-icon.png','assets/intro/intro.mp3','assets/intro/intro.json','vendor/adhs/adhs.js','vendor/adhs/adhs.css','vendor/adhs/LICENSE']) {
  if (!existsSync(path)) throw Error(`Missing deployment asset: ${path}`);
}
for (const path of ['landing.js','app.js','api/admin.js','admin/admin.js','intro.js','sw.js']) {
  const check = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (check.status !== 0) process.exit(check.status || 1);
}
console.log('Static production deployment check passed (Vercel serves source files directly).');
