import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createProxies } from '../../../packages/yt-dlp-wasm/test-harness/test-host.mjs';
import { FIXTURES, startMediaServer } from '../../../packages/yt-dlp-wasm/test/servers.mjs';

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
    await expect(alert).toContainText('404');
    await alert.getByRole('button', { name: 'Show log' }).click();
    await expect(page.locator('#log-panel')).toHaveJSProperty('open', true);
    await expect(page.locator('#log')).toContainText('404');
  });
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
  await page.getByRole('radio', { name: 'My own proxy' }).check();
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
