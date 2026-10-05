import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createProxies } from '../../../packages/yt-dlp-wasm/test-harness/test-host.mjs';
import { FIXTURES, cookiesFor, startMediaServer } from '../../../packages/yt-dlp-wasm/test/servers.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SITE = 'http://127.0.0.1:4173';
const PAGE = `${SITE}/`;
const fixtureBytes = (name) => [...fs.readFileSync(path.join(FIXTURES, name))];
const FTYP = [102, 116, 121, 112];

test.describe('with a media host behind the proxy', () => {
  test.describe.configure({ mode: 'serial' });
  let media;
  let proxies;
  let proxy;
  let page;

  test.beforeAll(async ({ browser }) => {
    media = await startMediaServer();
    proxies = createProxies(REPO_ROOT);
    proxy = await proxies.start(JSON.stringify({ ALLOWED_ORIGINS: SITE }), null);
    page = await browser.newPage();
    page.on('pageerror', (error) => console.log(`page error: ${error.message}`));
    const settings = { mode: 'own', url: `http://127.0.0.1:${proxy.port}/`, key: '' };
    await page.addInitScript((value) => localStorage.setItem('yt-dlp-wasm-demo', value), JSON.stringify(settings));
    await page.goto(PAGE);
  });

  test.afterAll(async () => {
    await page?.close();
    if (proxy) await proxies.stop(proxy.id);
    await media?.close();
  });

  // Starts a download and returns the saved file's name and bytes
  async function download(file) {
    await page.getByLabel('Link').fill(`${media.url}/${file}`);
    const [saved] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download' }).click(),
    ]);
    return { name: saved.suggestedFilename(), bytes: [...fs.readFileSync(await saved.path())] };
  }

  test('video downloads with its filename and shows the stages', async () => {
    await expect(page.locator('#audio-field')).toBeHidden();
    const { name, bytes } = await download('tiny.mp4');
    expect(name).toBe('tiny.mp4');
    expect(bytes).toEqual(fixtureBytes('tiny.mp4'));
    await expect(page.locator('#done')).toBeVisible();
    await expect(page.locator('#done-name')).toHaveText('tiny.mp4');
    await expect(page.locator('#media-title')).toHaveText('tiny');
    await expect(page.locator('#stages li[data-state="done"]')).toHaveCount(4);
  });

  test('audio converts to mp3 on ffmpeg.wasm', async () => {
    await page.getByRole('radio', { name: 'Audio' }).check();
    await expect(page.locator('#audio-field')).toBeVisible();
    const { name, bytes } = await download('tiny.mp4');
    expect(name).toBe('tiny.mp3');
    expect(bytes.length).toBeGreaterThan(1000);
  });

  test('audio can be m4a', async () => {
    await page.getByLabel('Audio format').selectOption('m4a');
    const { name, bytes } = await download('tiny.mp4');
    expect(name).toBe('tiny.m4a');
    expect(bytes.slice(4, 8)).toEqual(FTYP);
  });

  test('a failed download shows the error and offers the log', async () => {
    await page.getByLabel('Link').fill(`${media.url}/missing.mp4`);
    await page.getByRole('button', { name: 'Download' }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('That page or file was not found');
    await expect(alert).toContainText('404');
    await alert.getByRole('button', { name: 'Show log' }).click();
    await expect(page.locator('#log-panel')).toHaveJSProperty('open', true);
    await expect(page.locator('#log')).toContainText('404');
  });

  // Opens a fresh page that tracks its live workers
  async function openDemo(browser, browserSettings = { mode: 'own', url: `http://127.0.0.1:${proxy.port}/`, key: '' }) {
    const demo = await browser.newPage();
    const pageErrors = [];
    demo.on('pageerror', (error) => pageErrors.push(error.message));
    await demo.addInitScript((value) => {
      localStorage.setItem('yt-dlp-wasm-demo', value);
      const NativeWorker = window.Worker;
      window.liveWorkers = new Set();
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          window.liveWorkers.add(this);
        }

        terminate() {
          window.liveWorkers.delete(this);
          super.terminate();
        }
      };
    }, JSON.stringify(browserSettings));
    await demo.goto(PAGE);
    return { demo, pageErrors };
  }

  test('canceling during startup leaves no worker behind when the proxy settings change', async ({ browser }) => {
    const { demo } = await openDemo(browser);
    await demo.getByLabel('Link').fill(`${media.url}/tiny.mp4`);
    await demo.getByRole('button', { name: 'Download' }).click();
    await expect(demo.locator('#stages li[data-stage="runtime"][data-state="current"]')).toBeVisible();
    await demo.getByRole('button', { name: 'Cancel' }).click();
    await expect(demo.locator('#canceled')).toBeVisible();

    await demo.getByText('Proxy settings').click();
    await demo.getByLabel('Access key').fill('another-key');
    const [saved] = await Promise.all([
      demo.waitForEvent('download'),
      demo.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(saved.suggestedFilename()).toBe('tiny.mp4');
    await expect.poll(() => demo.evaluate(() => window.liveWorkers.size), { timeout: 120_000 }).toBe(1);
    await demo.close();
  });

  test('a cookies file reaches the media host through the proxy until it is cleared', async ({ browser }) => {
    const { demo, pageErrors } = await openDemo(browser);
    try {
      await demo.locator('#cookies-panel summary').click();
      await demo.getByLabel('Cookies file').setInputFiles({
        name: 'cookies.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(cookiesFor('127.0.0.1', 'session', 'abc')),
      });
      await expect(demo.locator('#cookies-status')).toHaveText('Loaded cookies.txt.');

      media.cookies.length = 0;
      await demo.getByLabel('Link').fill(`${media.url}/tiny.mp4`);
      let [saved] = await Promise.all([
        demo.waitForEvent('download'),
        demo.getByRole('button', { name: 'Download' }).click(),
      ]);
      expect(saved.suggestedFilename()).toBe('tiny.mp4');
      expect(media.cookies.length).toBeGreaterThan(0);
      expect(media.cookies.every((header) => header === 'session=abc')).toBe(true);

      const stored = await demo.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]));
      expect(stored).not.toContain('session');
      expect(stored).not.toContain('abc');

      await demo.getByRole('button', { name: 'Clear cookies' }).click();
      await expect(demo.locator('#cookies-loaded')).toBeHidden();
      await expect(demo.getByLabel('Cookies file')).toHaveValue('');
      await expect.poll(() => demo.evaluate(() => window.liveWorkers.size)).toBe(0);

      media.cookies.length = 0;
      [saved] = await Promise.all([
        demo.waitForEvent('download'),
        demo.getByRole('button', { name: 'Download' }).click(),
      ]);
      expect(saved.suggestedFilename()).toBe('tiny.mp4');
      expect(media.cookies.length).toBeGreaterThan(0);
      expect(media.cookies.every((header) => header === '')).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await demo.close();
    }
  });

  test('Cancel works while the proxy settings are invalid', async ({ browser }) => {
    const hung = http.createServer();
    await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
    const { demo, pageErrors } = await openDemo(browser);
    try {
      await demo.getByLabel('Link').fill(`http://127.0.0.1:${hung.address().port}/video.mp4`);
      await demo.getByRole('button', { name: 'Download' }).click();
      await expect(demo.locator('#stages li[data-stage="info"][data-state="current"]')).toBeVisible({ timeout: 120_000 });

      await demo.getByText('Proxy settings').click();
      await demo.getByLabel('Proxy URL').fill('ftp://not-a-proxy');
      await expect(demo.locator('#proxy-url-error')).toContainText('It must start with https://');
      await demo.getByRole('button', { name: 'Cancel' }).click();
      await expect(demo.locator('#canceled')).toBeVisible();
      await expect(demo.getByRole('button', { name: 'Download' })).toBeEnabled();
      await expect(demo.getByRole('button', { name: 'Cancel' })).toBeHidden();
      expect(pageErrors).toEqual([]);
      await expect.poll(() => demo.evaluate(() => window.liveWorkers.size)).toBe(0);

      await demo.getByLabel('Proxy URL').fill(`http://127.0.0.1:${proxy.port}/`);
      await expect(demo.locator('#proxy-url-error')).toBeHidden();
      await demo.getByLabel('Link').fill(`${media.url}/tiny.mp4`);
      const [saved] = await Promise.all([
        demo.waitForEvent('download'),
        demo.getByRole('button', { name: 'Download' }).click(),
      ]);
      expect(saved.suggestedFilename()).toBe('tiny.mp4');
    } finally {
      await demo.close();
      hung.closeAllConnections();
      hung.close();
    }
  });
});

test('the proxy URL must be https, or http on localhost', async ({ page }) => {
  await page.goto(PAGE);
  await page.getByText('Proxy settings').click();
  await page.getByRole('radio', { name: 'Custom proxy' }).check();
  const input = page.getByLabel('Proxy URL');
  const error = page.locator('#proxy-url-error');
  for (const url of ['http://proxy.example.com/', 'proxy.example.com']) {
    await input.fill(url);
    await expect(error).toHaveText('It must start with https://. http:// is allowed only for localhost and 127.0.0.1.');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
  }
  for (const url of ['https://proxy.example.com/', 'http://localhost:8787', 'http://127.0.0.1:8787/']) {
    await input.fill(url);
    await expect(error).toBeHidden();
  }
});

test('the cookies warning names the proxy in use', async ({ page }) => {
  await page.goto(PAGE);
  await page.locator('#cookies-panel summary').click();
  const warning = page.locator('#cookies-warning');
  await expect(warning).toContainText('pass through the demo proxy');
  await expect(warning).toContainText('Use a separate account');
  await expect(warning).toContainText('until you close or reload it');
  await expect(page.getByLabel('Cookies file')).toHaveAttribute('aria-describedby', /cookies-warning/);
  await page.getByText('Proxy settings').click();
  await page.getByRole('radio', { name: 'Custom proxy' }).check();
  await expect(warning).toContainText('pass through your proxy');
});

test('a cookies file that is too large is refused', async ({ page }) => {
  await page.goto(PAGE);
  await page.locator('#cookies-panel summary').click();
  await page.getByLabel('Cookies file').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(3 * 1024 * 1024) });
  await expect(page.locator('#cookies-error')).toHaveText('That file is too large for a cookies file.');
  await expect(page.locator('#cookies-loaded')).toBeHidden();
});

test('the page links to the repository above the fold', async ({ page }) => {
  await page.goto(PAGE);
  const link = page.locator('header').getByRole('link', { name: 'GitHub' });
  await expect(link).toHaveAttribute('href', 'https://github.com/Project516/yt-dlp-wasm');
  await expect(link).toBeInViewport();
  await expect(page.locator('footer').getByRole('link', { name: 'yt-dlp-wasm on GitHub' })).toHaveAttribute('href', 'https://github.com/Project516/yt-dlp-wasm');
});

test('proxy settings are saved in localStorage and never in the URL', async ({ page }) => {
  await page.goto(PAGE);
  await page.getByText('Proxy settings').click();
  await page.getByRole('radio', { name: 'Custom proxy' }).check();
  await page.getByLabel('Proxy URL').fill('https://proxy.example.com/');
  await page.getByLabel('Access key').fill('secret');
  await page.reload();
  await expect(page.getByLabel('Proxy URL')).toHaveValue('https://proxy.example.com/');
  await expect(page.getByLabel('Access key')).toHaveValue('secret');
  expect(page.url()).not.toContain('secret');
});

test('a browser without JSPI gets the error naming the supported browsers', async ({ page }) => {
  await page.addInitScript(() => { WebAssembly.Suspending = undefined; });
  await page.goto(PAGE);
  await page.getByLabel('Link').fill('https://example.com/video');
  await page.getByRole('button', { name: 'Download' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Chrome 137');
  await expect(alert).toContainText('Firefox 153');
  await expect(alert).toContainText('Safari 27');
});
