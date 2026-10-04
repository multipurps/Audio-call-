// app.js is loaded by the browser as an ES module, where duplicate function
// declarations and similar errors are fatal and blank the whole app. Parsing it
// as a plain function body does NOT catch them, so parse it as a module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const file of ['app.js', 'sw.js']) {
  test(`${file} parses as an ES module`, () => {
    const copy = join(mkdtempSync(join(tmpdir(), 'syntax-')), `${file}.mjs`);
    copyFileSync(new URL(`../${file}`, import.meta.url), copy);
    try {
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch (err) {
      assert.fail(`${file} does not parse as a module:\n${err.stderr?.toString()}`);
    }
  });
}
