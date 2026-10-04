// Builds yt-dlp's pure-Python wheel from the repository root into dist/ and
// records its file name in dist/wheel.json for the loaders. Also refreshes src/pins.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PINS, REQUIREMENTS, generatePins } from './update-pins.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageDir, '../..');
const dist = path.join(packageDir, 'dist');

fs.writeFileSync(PINS, generatePins(fs.readFileSync(REQUIREMENTS, 'utf8')));

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

// Prefer uv, which fetches the build backend itself
const builders = [
  ['uv', ['build', '--wheel', '--out-dir', dist, repoRoot]],
  ['python3', ['-m', 'build', '--wheel', '--outdir', dist, repoRoot]],
];
const built = builders.some(([command, args]) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return !result.error && result.status === 0;
});
if (!built) {
  console.error('Building the wheel needs `uv`, or `python3` with the `build` package.');
  process.exit(1);
}

// uv drops a catch-all .gitignore here, which would keep npm from packing dist/
fs.rmSync(path.join(dist, '.gitignore'), { force: true });

const wheels = fs.readdirSync(dist).filter((name) => name.endsWith('.whl'));
if (wheels.length !== 1) {
  console.error(`Expected one wheel in ${dist}, found ${wheels.length}.`);
  process.exit(1);
}
fs.writeFileSync(path.join(dist, 'wheel.json'), `${JSON.stringify({ wheel: wheels[0] })}\n`);
console.log(`Wrote ${wheels[0]}`);
