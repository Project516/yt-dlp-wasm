import { createYtDlp } from '@project516/yt-dlp-wasm';
import './style.css';
import { explain } from './explain.js';
import { formatBytes, formatDuration, formatEta } from './format.js';
import { retryFlagged } from './retry.js';

const wheels = import.meta.glob('../../../packages/yt-dlp-wasm/dist/*.whl', { query: '?url', import: 'default', eager: true });
const [wheelURL] = Object.values(wheels);

const DEMO_PROXY = import.meta.env.VITE_DEMO_PROXY_URL || 'https://yt-dlp-demo-proxy.project516.dev';
const STORAGE_KEY = 'yt-dlp-wasm-demo';
const MAX_LOG_LINES = 2000;
const MAX_COOKIES_BYTES = 2 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const VIDEO_OPTIONS = {
  format: 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b',
  merge_output_format: 'mp4',
};
const audioOptions = (codec) => ({
  format: codec === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b',
  postprocessors: [{ key: 'FFmpegExtractAudio', preferredcodec: codec, preferredquality: '192' }],
});

const STAGES = ['runtime', 'info', 'download', 'process'];
const STAGE_LABELS = { runtime: 'Loading the runtime', info: 'Fetching info', download: 'Downloading', process: 'Processing', done: 'Done' };
const PROCESS_LABELS = { Merger: 'Merging video and audio', ExtractAudio: 'Converting the audio' };

const $ = (id) => document.getElementById(id);
const form = $('form');
const urlInput = $('url');
const goButton = $('go');
const cancelButton = $('cancel');
const errorBox = $('error');
const mediaBox = $('media');
const stageList = $('stages');
const bar = $('bar');
const logPanel = $('log-panel');
const proxyPanel = $('proxy-panel');
const logEl = $('log');

// Settings

function loadSettings() {
  try {
    return { mode: 'demo', url: '', key: '', ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return { mode: 'demo', url: '', key: '' };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private mode: settings last for this page only */ }
}

const settings = loadSettings();
const proxyModes = document.querySelectorAll('input[name="proxy-mode"]');

function showSettings() {
  for (const radio of proxyModes) radio.checked = radio.value === settings.mode;
  $('own-fields').hidden = settings.mode !== 'own';
  $('proxy-url').value = settings.url;
  $('proxy-key').value = settings.key;
}

function readSettings() {
  settings.mode = document.querySelector('input[name="proxy-mode"]:checked').value;
  settings.url = $('proxy-url').value.trim();
  settings.key = $('proxy-key').value;
  $('own-fields').hidden = settings.mode !== 'own';
  saveSettings(settings);
  showProxyUrlProblem();
}

function showProxyUrlProblem() {
  const problem = settings.mode === 'own' && settings.url ? proxyUrlProblem(settings.url) : '';
  $('proxy-url-error').textContent = problem;
  $('proxy-url-error').hidden = !problem;
  $('proxy-url').setAttribute('aria-invalid', String(Boolean(problem)));
}

proxyPanel.addEventListener('input', readSettings);
showSettings();
showProxyUrlProblem();

const usingDemoProxy = () => settings.mode === 'demo';

// Cookies

// A cookies file is a login, so it stays in memory and is never saved or put in a URL.
// The version keys the runtime, so a changed file starts a fresh one without the text in the key.
const cookies = { text: '', version: 0 };
const cookiesInput = $('cookies-file');
let cookiesSelection = 0;

function showCookiesError(message) {
  $('cookies-error').textContent = message;
  $('cookies-error').hidden = !message;
  cookiesInput.setAttribute('aria-invalid', String(Boolean(message)));
}

function setCookies(text, name) {
  if (!text && !cookies.text) return;
  cookies.text = text;
  cookies.version++;
  $('cookies-status').textContent = name ? `Loaded ${name}.` : '';
  $('cookies-loaded').hidden = !name;
  if (!name) cookiesInput.value = '';
  // The old runtime still holds the previous cookies. A run in progress keeps them until it ends.
  if (!busy) dropInstance();
}

// A read that finishes after Clear or a newer selection is dropped
cookiesInput.addEventListener('change', async () => {
  const selection = ++cookiesSelection;
  const [file] = cookiesInput.files;
  showCookiesError('');
  if (!file) return setCookies('', '');
  if (file.size > MAX_COOKIES_BYTES) {
    setCookies('', '');
    return showCookiesError('That file is too large for a cookies file.');
  }
  try {
    const text = await file.text();
    if (selection === cookiesSelection) setCookies(text, file.name);
  } catch {
    if (selection !== cookiesSelection) return;
    setCookies('', '');
    showCookiesError('This page could not read that file.');
  }
});

$('cookies-clear').addEventListener('click', () => {
  cookiesSelection++;
  showCookiesError('');
  setCookies('', '');
  cookiesInput.focus();
});

// Log

const logLines = [];

function onLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
  if (logPanel.open) logEl.append(`${line}\n`);
}

logPanel.addEventListener('toggle', () => {
  if (logPanel.open) logEl.textContent = logLines.map((line) => `${line}\n`).join('');
});

$('copy-log').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => { button.textContent = 'Copy log'; }, 2000);
});

$('show-log').addEventListener('click', () => {
  logPanel.open = true;
  logEl.focus();
});

// Runtime instance

let instance;
const SUPERSEDED = new Error('This runtime was replaced');

function dropInstance() {
  instance?.ytdlp?.terminate();
  instance = undefined;
}

function getYtDlp(proxy) {
  const key = JSON.stringify([proxy, cookies.version]);
  if (instance?.key === key) return instance.promise;
  dropInstance();
  const entry = { key, ytdlp: null };
  entry.promise = createYtDlp({ ...proxy, cookies: cookies.text || undefined, wheelURL, onLog }).then((ytdlp) => {
    if (instance !== entry) {
      ytdlp.terminate();
      throw SUPERSEDED;
    }
    entry.ytdlp = ytdlp;
    return ytdlp;
  }, (error) => {
    if (instance === entry) instance = undefined;
    throw error;
  });
  instance = entry;
  return entry.promise;
}

function proxyUrlProblem(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'https:' || (protocol === 'http:' && LOCAL_HOSTS.has(hostname))) return '';
  } catch { /* reported below */ }
  return 'It must start with https://. http:// is allowed only for localhost and 127.0.0.1.';
}

function proxyProblem() {
  if (settings.mode === 'demo') return null;
  if (!settings.url) return { title: 'Enter your proxy URL', detail: 'Add it in the proxy settings, or switch to the demo proxy.' };
  const detail = proxyUrlProblem(settings.url);
  return detail ? { title: 'The proxy URL is not valid', detail } : null;
}

function proxySettings() {
  const problem = proxyProblem();
  if (problem) throw new UserError(problem.title, problem.detail, $('proxy-url'));
  return settings.mode === 'demo'
    ? { corsProxy: DEMO_PROXY }
    : { corsProxy: settings.url, corsProxyKey: settings.key || undefined };
}

class UserError extends Error {
  constructor(title, detail, target) {
    super(detail);
    this.title = title;
    this.target = target;
  }
}

// UI state

function setStage(stage) {
  const current = STAGES.indexOf(stage);
  stageList.hidden = false;
  STAGES.forEach((name, index) => {
    const item = stageList.querySelector(`[data-stage="${name}"]`);
    if (stage === 'done' || index < current) item.dataset.state = 'done';
    else if (index === current) item.dataset.state = 'current';
    else delete item.dataset.state;
    if (index === current) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
  if (stage === 'process' || stage === 'done') bar.value = 1;
  $('announce').textContent = STAGE_LABELS[stage];
}

function showError(title, detail) {
  errorBox.querySelector('.error-title').textContent = title;
  errorBox.querySelector('.error-detail').textContent = detail;
  errorBox.hidden = false;
}

function showMedia(info) {
  $('media-title').textContent = info.title ?? 'Untitled';
  $('media-meta').textContent = [info.uploader ?? info.channel, formatDuration(info.duration)].filter(Boolean).join(' / ');
  const thumb = $('thumb');
  thumb.hidden = true;
  thumb.onload = () => { thumb.hidden = false; };
  thumb.onerror = () => { thumb.hidden = true; };
  if (info.thumbnail) thumb.src = info.thumbnail;
  else thumb.removeAttribute('src');
  mediaBox.hidden = false;
}

function resetView() {
  errorBox.hidden = true;
  mediaBox.hidden = true;
  stageList.hidden = true;
  $('done').hidden = true;
  $('canceled').hidden = true;
  bar.removeAttribute('value');
  $('info-detail').textContent = '';
  $('download-detail').textContent = '';
  $('process-detail').textContent = '';
  logLines.length = 0;
  logEl.textContent = '';
}

let busy = false;

function setBusy(value) {
  busy = value;
  goButton.disabled = busy;
  cancelButton.hidden = !busy;
  form.setAttribute('aria-busy', String(busy));
}

let blobUrl;

function saveFile(file) {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
  const link = $('done-link');
  link.href = blobUrl;
  link.download = file.name;
  $('done-name').textContent = file.name;
  $('done-size').textContent = `(${formatBytes(file.data.byteLength)})`;
  $('done').hidden = false;
  link.click();
}

// Download

let current;

function progressHandler(run) {
  let finishedParts = 0;
  return (event) => {
    if (run.canceled) return;
    if (event.type === 'download') {
      if (event.status === 'finished') {
        finishedParts++;
        bar.removeAttribute('value');
        $('download-detail').textContent = '';
        return;
      }
      if (event.status !== 'downloading') return;
      const { downloadedBytes, totalBytes, speed, eta } = event;
      if (totalBytes) bar.value = downloadedBytes / totalBytes;
      else bar.removeAttribute('value');
      $('download-detail').textContent = [
        finishedParts ? `Part ${finishedParts + 1}` : '',
        totalBytes ? `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}` : formatBytes(downloadedBytes),
        speed ? `${formatBytes(speed)}/s` : '',
        formatEta(eta),
      ].filter(Boolean).join(', ');
    } else if (event.postprocessor !== 'MoveFiles') {
      setStage('process');
      $('process-detail').textContent = PROCESS_LABELS[event.postprocessor] ?? 'Processing with ffmpeg';
    }
  };
}

async function start(url, kind, codec) {
  const run = { canceled: false };
  current = run;
  resetView();
  setBusy(true);
  try {
    let parsed;
    try {
      parsed = new URL(url);
    } catch { /* checked below */ }
    if (!/^https?:$/.test(parsed?.protocol)) throw new UserError('Enter a link', 'It must start with http:// or https://.', urlInput);
    const proxy = proxySettings();

    setStage('runtime');
    const ytdlp = await getYtDlp(proxy);
    if (run.canceled) return;

    setStage('info');
    const info = await retryFlagged(() => ytdlp.extractInfo(url, { noplaylist: true }), {
      canceled: () => run.canceled,
      onRetry: (attempt, retries) => {
        $('info-detail').textContent = `The site refused the proxy. Trying again (${attempt} of ${retries}).`;
        onLog(`[demo] The site refused the proxy, trying again (${attempt} of ${retries})`);
      },
    });
    if (run.canceled) return;
    $('info-detail').textContent = '';
    if (info._type === 'playlist') throw new UserError('This link is a playlist', 'Paste the link of one video.');
    showMedia(info);

    setStage('download');
    const options = {
      noplaylist: true,
      playlist_items: '1',
      outtmpl: '%(title).120B.%(ext)s',
      ...(kind === 'audio' ? audioOptions(codec) : VIDEO_OPTIONS),
    };
    const [file] = await ytdlp.download(info, options, { onProgress: progressHandler(run) });
    if (run.canceled) return;
    if (!file) throw new UserError('No file was produced', 'Open the log to see what yt-dlp did.');

    setStage('done');
    saveFile(file);
  } catch (error) {
    if (run.canceled) return;
    stageList.hidden = true;
    if (error instanceof UserError) {
      showError(error.title, error.message);
      const panel = error.target?.closest('details');
      if (panel) panel.open = true;
      error.target?.focus();
    } else {
      const { title, detail } = explain(error, { usingDemoProxy: usingDemoProxy(), hasCookies: Boolean(cookies.text) });
      showError(title, detail);
    }
    $('show-log').hidden = !logLines.length;
  } finally {
    if (current === run) setBusy(false);
  }
}

function cancel() {
  current.canceled = true;
  setBusy(false);
  resetView();
  $('canceled').hidden = false;
  // terminate() is the only way to stop a running download, so start a fresh runtime
  if (!instance?.ytdlp) return;
  dropInstance();
  if (proxyProblem()) return;
  getYtDlp(proxySettings()).catch((error) => {
    if (error !== SUPERSEDED) onLog(`Could not restart the runtime: ${error.message}`);
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  start(String(data.get('url')).trim(), data.get('kind'), data.get('codec'));
});

cancelButton.addEventListener('click', cancel);

form.addEventListener('change', () => {
  $('audio-field').hidden = new FormData(form).get('kind') !== 'audio';
});
