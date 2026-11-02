import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { before, test } from 'node:test';
import createFFmpegCore from '@project516/ffmpeg-wasm-core';
import { coreFactory, createFfmpegRunner } from '../src/ffmpeg-bridge.mjs';

const decode = (bytes) => new TextDecoder().decode(bytes);
let factory;
// A second core's filesystem stands in for Pyodide's: both are Emscripten FS.
let pyFS;

before(async () => {
  const wasm = await fs.readFile(new URL(import.meta.resolve('@project516/ffmpeg-wasm-core/wasm')));
  factory = coreFactory(createFFmpegCore, await WebAssembly.compile(wasm));
  pyFS = (await factory({})).FS;
  pyFS.mkdirTree('/work');
});

function runner(wrap = (core) => core) {
  const cores = [];
  const run = createFfmpegRunner({
    FS: pyFS,
    createCore: async (options) => {
      const core = wrap(await factory(options), cores.length);
      cores.push(core);
      return core;
    },
  });
  return { run, cores };
}

test('commands share one core and keep their own output', async () => {
  const { run, cores } = runner();
  const made = await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64', '-pix_fmt', 'yuv420p', 'in.mp4'], '/work', new Uint8Array());
  assert.equal(made.code, 0);
  assert.ok(pyFS.readFile('/work/in.mp4').length > 0);

  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', 'in.mp4'], '/work', new Uint8Array());
  assert.equal(probe.code, 0);
  assert.match(decode(probe.stdout), /duration=1\.0/);

  const missing = await run('ffmpeg', ['-i', 'missing.mp4', 'out.mkv'], '/work', new Uint8Array());
  assert.notEqual(missing.code, 0);
  assert.match(decode(missing.stderr), /missing\.mp4/);

  const remux = await run('ffmpeg', ['-i', 'in.mp4', '-c', 'copy', 'out.mkv'], '/work', new Uint8Array());
  assert.equal(remux.code, 0);
  assert.doesNotMatch(decode(remux.stderr), /missing\.mp4/);
  assert.equal(decode(remux.stdout), '');
  assert.ok(pyFS.readFile('/work/out.mkv').length > 0);

  assert.equal(cores.length, 1);
  assert.deepEqual(cores[0].FS.readdir('/work'), ['.', '..']);
});

test('a command that throws gets a new core next time', async () => {
  const { run, cores } = runner((core, index) => {
    if (index === 0) core.exec = () => { throw new WebAssembly.RuntimeError('unreachable'); };
    return core;
  });
  const failed = await run('ffmpeg', ['-version'], '/work', new Uint8Array());
  assert.equal(failed.code, 1);
  assert.match(decode(failed.stderr), /unreachable/);

  const next = await run('ffmpeg', ['-version'], '/work', new Uint8Array());
  assert.equal(next.code, 0);
  assert.match(decode(next.stdout), /ffmpeg version/);
  assert.equal(cores.length, 2);
});

test('a failed cleanup gets a new core next time', async () => {
  const { run, cores } = runner((core, index) => {
    if (index === 0) core.FS.unlink = () => { throw new Error('unlink failed'); };
    return core;
  });
  const args = ['-f', 'lavfi', '-i', 'testsrc=duration=0.1:size=32x32', 'cleanup.mp4'];
  await assert.rejects(run('ffmpeg', args, '/work', new Uint8Array()), /unlink failed/);
  assert.equal((await run('ffmpeg', args, '/work', new Uint8Array())).code, 0);
  assert.equal(cores.length, 2);
  assert.deepEqual(cores[1].FS.readdir('/work'), ['.', '..']);
});
