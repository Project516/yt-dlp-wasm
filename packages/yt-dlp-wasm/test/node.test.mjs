import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createYtDlp, YtDlpError } from '../src/node.mjs';
import { FIXTURES, startMediaServer } from './servers.mjs';

describe('yt-dlp-wasm in Node.js', () => {
  let media;
  let ytdlp;
  let outputDir;
  const logs = [];

  before(async () => {
    media = await startMediaServer();
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-wasm-'));
    ytdlp = await createYtDlp({ onLog: (line, stream) => logs.push({ line, stream }) });
  });

  after(async () => {
    await ytdlp?.close();
    await media.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  test('run returns the exit code', async () => {
    assert.equal(await ytdlp.run(['--version']), 0);
    assert.match(logs.find(({ stream }) => stream === 'stdout').line, /^\d{4}\.\d{2}\.\d{2}/);
    assert.notEqual(await ytdlp.run(['--no-such-option']), 0);
  });

  test('extractInfo returns the info dict', async () => {
    const info = await ytdlp.extractInfo(`${media.url}/tiny.mp4`);
    assert.equal(info.id, 'tiny');
    assert.equal(info.ext, 'mp4');
    assert.equal(info.formats.length, 1);
  });

  test('download writes the file and reports progress', async () => {
    const events = [];
    const files = await ytdlp.download(`${media.url}/tiny.mp4`, { outtmpl: 'tiny.%(ext)s' }, { outputDir, onProgress: (event) => events.push(event) });
    assert.equal(files.length, 1);
    const [file] = files;
    assert.equal(file.name, 'tiny.mp4');
    assert.equal(file.mimeType, 'video/mp4');
    assert.equal(file.path, path.join(outputDir, 'tiny.mp4'));
    assert.deepEqual(fs.readFileSync(file.path), fs.readFileSync(path.join(FIXTURES, 'tiny.mp4')));
    const finished = events.find((event) => event.type === 'download' && event.status === 'finished');
    assert.equal(finished.downloadedBytes, file.size);
  });

  test('download takes an info dict from extractInfo', async () => {
    const info = await ytdlp.extractInfo(`${media.url}/tiny.mp4`);
    const files = await ytdlp.download(info, { outtmpl: 'from-info.%(ext)s' }, { outputDir });
    assert.deepEqual(files.map(({ name }) => name), ['from-info.mp4']);
    assert.deepEqual(fs.readFileSync(files[0].path), fs.readFileSync(path.join(FIXTURES, 'tiny.mp4')));
  });

  test('download runs postprocessors on ffmpeg.wasm', async () => {
    const events = [];
    const files = await ytdlp.download(`${media.url}/tiny.mp4`, {
      outtmpl: 'audio.%(ext)s',
      postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: 'm4a' }],
    }, { outputDir, onProgress: (event) => events.push(event) });
    assert.deepEqual(files.map(({ name }) => name), ['audio.m4a']);
    const finished = events.filter((event) => event.type === 'postprocessor' && event.status === 'finished');
    assert.deepEqual(finished.map(({ postprocessor }) => postprocessor), ['ExtractAudio', 'MoveFiles']);
    assert.ok(fs.statSync(files[0].path).size > 0);
  });

  test('a failed download rejects with YtDlpError', async () => {
    await assert.rejects(ytdlp.download(`${media.url}/missing.mp4`, {}, { outputDir }), (error) => {
      assert.ok(error instanceof YtDlpError);
      assert.equal(error.type, 'DownloadError');
      return true;
    });
  });

  test('a closed instance rejects new calls', async () => {
    const other = await createYtDlp();
    await other.close();
    await assert.rejects(other.run(['--version']), /closed/);
  });
});
