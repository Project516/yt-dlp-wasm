import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { PACKAGES, PINS, REQUIREMENTS, generatePins, packageName, parseRequirements } from '../scripts/update-pins.mjs';

const requirements = fs.readFileSync(REQUIREMENTS, 'utf8');

test('pins.json matches upstream requirements, run `node scripts/update-pins.mjs` if not', () => {
  assert.equal(fs.readFileSync(PINS, 'utf8'), generatePins(requirements));
});

test('every upstream dependency is classified in scripts/update-pins.mjs', () => {
  const known = Object.values(PACKAGES).flat();
  const unknown = parseRequirements(requirements).map(packageName).filter((name) => !known.includes(name));
  assert.deepEqual([...new Set(unknown)], []);
});

test('parseRequirements drops hashes and keeps markers', () => {
  const text = "a==1 ; python_full_version < '3.11' \\\n    --hash=sha256:00 \\\n    --hash=sha256:11\nb==2 \\\n    --hash=sha256:22\n";
  assert.deepEqual(parseRequirements(text), ["a==1 ; python_full_version < '3.11'", 'b==2']);
});
