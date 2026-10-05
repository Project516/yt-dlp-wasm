import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createYtDlp, YtDlpError } from '../src/node.mjs';
import { cookiesFor, startMediaServer } from './servers.mjs';

describe('cookies in Node.js', () => {
  let media;
  let ytdlp;
  let outputDir;
  const url = () => `${media.url}/tiny.mp4`;

  before(async () => {
    media = await startMediaServer();
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-wasm-cookies-'));
    ytdlp = await createYtDlp({ cookies: cookiesFor('127.0.0.1', 'session', 'abc') });
  });

  after(async () => {
    await ytdlp?.close();
    await media.close();
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  const cookieHeaders = async (action) => {
    media.cookies.length = 0;
    await action();
    assert.ok(media.cookies.length > 0);
    return media.cookies;
  };

  test('extractInfo sends the cookie to the host', async () => {
    const headers = await cookieHeaders(() => ytdlp.extractInfo(url()));
    assert.ok(headers.every((header) => header === 'session=abc'), headers.join(' | '));
  });

  test('download sends the cookie and does not return or write the cookies file', async () => {
    const headers = await cookieHeaders(async () => {
      const files = await ytdlp.download(url(), { outtmpl: 'tiny.%(ext)s' }, { outputDir });
      assert.deepEqual(files.map(({ name }) => name), ['tiny.mp4']);
    });
    assert.ok(headers.every((header) => header === 'session=abc'), headers.join(' | '));
    assert.deepEqual(fs.readdirSync(outputDir), ['tiny.mp4']);
  });

  test('an explicit cookiefile option wins', async () => {
    const cookiefile = path.join(outputDir, 'other-cookies.txt');
    fs.writeFileSync(cookiefile, cookiesFor('127.0.0.1', 'session', 'other'));
    const headers = await cookieHeaders(async () => {
      const files = await ytdlp.download(url(), { cookiefile, outtmpl: 'explicit.%(ext)s' }, { outputDir });
      assert.deepEqual(files.map(({ name }) => name), ['explicit.mp4']);
    });
    assert.ok(headers.every((header) => header === 'session=other'), headers.join(' | '));
  });

  test('run adds --cookies unless the arguments choose', async () => {
    const simulate = (...args) => async () => assert.equal(await ytdlp.run(['--simulate', ...args, url()]), 0);
    const added = await cookieHeaders(simulate());
    assert.ok(added.every((header) => header === 'session=abc'), added.join(' | '));

    media.cookies.length = 0;
    await simulate('--no-cookies')();
    assert.ok(media.cookies.length > 0);
    assert.ok(media.cookies.every((header) => header === ''), media.cookies.join(' | '));
  });

  test('an invalid cookies file surfaces the yt-dlp error', async () => {
    const broken = await createYtDlp({ cookies: 'this is not a cookies file' });
    try {
      await assert.rejects(broken.extractInfo(url()), (error) => {
        assert.ok(error instanceof YtDlpError);
        assert.match(error.message, /cookies/i);
        return true;
      });
    } finally {
      await broken.close();
    }
  });

  test('cookies must be text', async () => {
    await assert.rejects(createYtDlp({ cookies: 42 }), TypeError);
  });
});
