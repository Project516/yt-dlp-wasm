import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createProxies } from '../test-harness/test-host.mjs';
import { FIXTURES, PACKAGE_ROOT, cookiesFor, startMediaServer, startSiteServer } from '../test/servers.mjs';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const fixtureBytes = (name) => [...fs.readFileSync(path.join(FIXTURES, name))];
const FTYP = [102, 116, 121, 112];

async function openPage(browser, site, options = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
  await page.goto(`${site.url}/test-browser/page.html`);
  await page.evaluate(async (options) => {
    const { createYtDlp } = await import('/src/browser.mjs');
    window.logs = [];
    window.ytdlp = await createYtDlp({ ...options, onLog: (line, stream) => window.logs.push([stream, line]) });
  }, options);
  return page;
}

// Runs download() in the page and returns files with their bytes as plain arrays
const download = (page, url, options) => page.evaluate(async ([url, options]) => {
  const events = [];
  const files = await window.ytdlp.download(url, options, { onProgress: (event) => events.push(event) });
  return { events, files: files.map(({ name, mimeType, data }) => ({ name, mimeType, bytes: Array.from(data) })) };
}, [url, options]);

test.describe('a media host that allows CORS', () => {
  test.describe.configure({ mode: 'serial' });
  let site;
  let media;
  let page;

  test.beforeAll(async ({ browser }) => {
    [site, media] = await Promise.all([startSiteServer(), startMediaServer({ cors: true })]);
    page = await openPage(browser, site);
  });

  test.afterAll(async () => {
    await page?.evaluate(() => window.ytdlp.close());
    await page?.close();
    await Promise.all([site?.close(), media?.close()]);
  });

  test('run returns the exit code and logs to onLog', async () => {
    expect(await page.evaluate(() => window.ytdlp.run(['--version']))).toBe(0);
    const logs = await page.evaluate(() => window.logs);
    expect(logs.some(([stream, line]) => stream === 'stdout' && /^\d{4}\.\d{2}\.\d{2}/.test(line))).toBe(true);
  });

  test('extractInfo returns the info dict', async () => {
    const info = await page.evaluate((url) => window.ytdlp.extractInfo(url), `${media.url}/tiny.mp4`);
    expect(info).toMatchObject({ id: 'tiny', ext: 'mp4' });
  });

  test('download returns the file and reports progress', async () => {
    const { events, files } = await download(page, `${media.url}/tiny.mp4`, { outtmpl: 'out.%(ext)s' });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'out.mp4', mimeType: 'video/mp4' });
    expect(files[0].bytes).toEqual(fixtureBytes('tiny.mp4'));
    expect(events.some((event) => event.type === 'download' && event.status === 'finished')).toBe(true);
  });

  test('download runs ffmpeg.wasm to extract audio', async () => {
    const { events, files } = await download(page, `${media.url}/tiny.mp4`, {
      outtmpl: 'audio.%(ext)s',
      postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: 'm4a' }],
    });
    expect(files.map(({ name }) => name)).toEqual(['audio.m4a']);
    expect(files[0].mimeType).toBe('audio/mp4');
    expect(files[0].bytes.slice(4, 8)).toEqual(FTYP);
    expect(events.some((event) => event.type === 'postprocessor' && event.postprocessor === 'ExtractAudio' && event.status === 'finished')).toBe(true);
  });

  test('a failed download rejects with the yt-dlp error', async () => {
    const error = await page.evaluate((url) => window.ytdlp.download(url).then(() => null, ({ name, type, message }) => ({ name, type, message })), `${media.url}/missing.mp4`);
    expect(error).toMatchObject({ name: 'YtDlpError', type: 'DownloadError' });
    expect(error.message).toContain('404');
  });

  test('the JS host runs scripts in a nested worker', async () => {
    const stdout = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/test-browser/host-worker.mjs', { type: 'module' });
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage('console.log(6 * 7)');
    }));
    expect(stdout).toBe('42\n');
  });
});

test.describe('a media host without CORS, through the proxy', () => {
  let site;
  let media;
  let proxies;
  let proxy;
  let page;

  test.beforeAll(async ({ browser }) => {
    [site, media] = await Promise.all([startSiteServer(), startMediaServer()]);
    proxies = createProxies(REPO_ROOT);
    proxy = await proxies.start(JSON.stringify({ ALLOWED_ORIGINS: site.url }), null);
    page = await openPage(browser, site, { corsProxy: `http://127.0.0.1:${proxy.port}/` });
  });

  test.afterAll(async () => {
    await page?.evaluate(() => window.ytdlp.close());
    await page?.close();
    if (proxy) await proxies.stop(proxy.id);
    await Promise.all([site?.close(), media?.close()]);
  });

  test('download goes through the proxy', async () => {
    const { files } = await download(page, `${media.url}/tiny.m4a`, { outtmpl: 'song.%(ext)s' });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'song.m4a', mimeType: 'audio/mp4' });
    expect(files[0].bytes).toEqual(fixtureBytes('tiny.m4a'));
  });

  test('the cookies option reaches the media host through the proxy', async ({ browser }) => {
    const cookiePage = await openPage(browser, site, {
      corsProxy: `http://127.0.0.1:${proxy.port}/`,
      cookies: cookiesFor('127.0.0.1', 'session', 'abc'),
    });
    try {
      media.cookies.length = 0;
      const { files } = await download(cookiePage, `${media.url}/tiny.m4a`, { outtmpl: 'song.%(ext)s' });
      expect(files.map(({ name }) => name)).toEqual(['song.m4a']);
      expect(media.cookies.length).toBeGreaterThan(0);
      expect(media.cookies.every((header) => header === 'session=abc')).toBe(true);
    } finally {
      await cookiePage.evaluate(() => window.ytdlp.close());
      await cookiePage.close();
    }
  });
});

test('createYtDlp names the supported browsers when JSPI is missing', async ({ browser }) => {
  const site = await startSiteServer();
  const page = await browser.newPage();
  await page.addInitScript(() => { WebAssembly.Suspending = undefined; });
  await page.goto(`${site.url}/test-browser/page.html`);
  const message = await page.evaluate(async () => {
    const { createYtDlp } = await import('/src/browser.mjs');
    return createYtDlp().then(() => null, (error) => error.message);
  });
  expect(message).toContain('Chrome 137');
  expect(message).toContain('Firefox 153');
  expect(message).toContain('Safari 27');
  await page.close();
  await site.close();
});
