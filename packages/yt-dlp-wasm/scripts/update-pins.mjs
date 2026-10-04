// Writes src/pins.json from upstream's bundle/requirements/default.txt. The build runs it,
// and so does the upstream sync, so each sync takes upstream's pins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every package in default.txt must be listed here. test/pins.test.mjs fails on a new one.
export const PACKAGES = {
  // Pyodide's own lockfile pins these, see src/dependencies.mjs
  pyodide: ['brotli', 'certifi', 'pycryptodomex'],
  // micropip installs these from PyPI at the pinned version
  pypi: ['mutagen', 'websockets', 'yt-dlp-ejs'],
  // The fetch handler and Pyodide replace these
  unused: ['brotlicffi', 'charset-normalizer', 'idna', 'pycparser', 'requests', 'urllib3'],
};

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIREMENTS = path.join(packageDir, '../../bundle/requirements/default.txt');
export const PINS = path.join(packageDir, 'src/pins.json');

// One requirement per line without hashes, e.g. "websockets==17.0.1 ; python_full_version >= '3.11'"
export function parseRequirements(text) {
  return text
    .split('\n')
    .filter((line) => /^[A-Za-z]/.test(line))
    .map((line) => line.replace(/\s*\\$/, '').trim());
}

export const packageName = (requirement) => requirement.match(/^[A-Za-z0-9._-]+/)[0].toLowerCase();

export function generatePins(text) {
  const pypi = parseRequirements(text).filter((requirement) => PACKAGES.pypi.includes(packageName(requirement)));
  const missing = PACKAGES.pypi.filter((name) => !pypi.some((requirement) => packageName(requirement) === name));
  if (missing.length) throw new Error(`default.txt has no pin for ${missing.join(', ')}`);
  return `${JSON.stringify({ pypi }, null, 2)}\n`;
}

if (import.meta.main) {
  fs.writeFileSync(PINS, generatePins(fs.readFileSync(REQUIREMENTS, 'utf8')));
}
