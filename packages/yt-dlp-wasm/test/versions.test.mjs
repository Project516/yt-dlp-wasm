import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { FFMPEG_CORE_VERSION, PYODIDE_VERSION } from '../src/versions.mjs';

test('the CDN versions match the pinned dependencies', () => {
  const { dependencies } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PYODIDE_VERSION, dependencies.pyodide);
  assert.equal(FFMPEG_CORE_VERSION, dependencies['@project516/ffmpeg-wasm-core']);
});
