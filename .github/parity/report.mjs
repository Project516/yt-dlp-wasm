// Merges the JUnit files of the site-parity shards into one report.
//   node report.mjs <ids-file> <junit-dir> <out-dir>
// Reads <junit-dir>/native-*.xml and <junit-dir>/wasm-*.xml. Writes
// parity-report.json, parity-cases.csv and parity-report.md to <out-dir>,
// and the job summary markdown to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RUNTIMES = ['native', 'wasm'];
const [idsFile, junitDir, outDir] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: report.mjs <ids-file> <junit-dir> <out-dir>');
  process.exit(2);
}

const unescapeXml = (text) => text
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&amp;/g, '&');

const attributes = (text) => Object.fromEntries(
  [...text.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescapeXml(value)]));

// The last entry for a case wins, so a rerun replaces the failure before it
export function parseJunit(xml) {
  const cases = new Map();
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const { name, time } = attributes(match[1]);
    const body = match[2] ?? '';
    const problem = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b([^>]*?)(?:\/>|>([\s\S]*?)<\/skipped>)/.exec(body);
    let result;
    if (problem) {
      const { message = '' } = attributes(problem[2]);
      result = { status: 'fail', message, detail: unescapeXml(problem[3] ?? '') };
    } else if (skipped) {
      result = { status: 'skip', message: attributes(skipped[1]).message ?? '', detail: '' };
    } else {
      result = { status: 'pass', message: '', detail: '' };
    }
    cases.set(name, { ...result, seconds: Number(time) || 0 });
  }
  return cases;
}

const REASONS = [
  [/impersonat/i, () => 'impersonation required'],
  [/Unsupported ?Request/i, () => 'UnsupportedRequest'],
  [/NoSupportingHandlers|Unable to handle request/, () => 'no supporting handler'],
  [/HTTP Error (\d{3})/, (match) => `HTTP ${match[1]}`],
  [/Timeout|timed out/i, () => 'timeout'],
  [/TransportError|Failed to fetch|NetworkError|Connection (?:reset|refused|aborted)/i, () => 'network error'],
  [/Unsupported URL/, () => 'Unsupported URL'],
  [/geo.?restrict|not available in your country/i, () => 'geo restricted'],
  [/\(caused by (\w+)/, (match) => `caused by ${match[1]}`],
  [/Unable to extract/, () => 'Unable to extract'],
  [/AssertionError/, () => 'AssertionError (extracted data differs)'],
  [/ExtractorError/, () => 'ExtractorError'],
];

// The traceback quotes source lines that name unrelated errors, so only the exception text counts
const exceptionText = ({ message, detail }) => message || detail.split('\n').filter((line) => line.startsWith('E ')).join('\n');

export function failureReason(result) {
  const text = exceptionText(result);
  for (const [pattern, label] of REASONS) {
    const match = pattern.exec(text);
    if (match) return label(match);
  }
  const type = /^([\w.]+(?:Error|Exception|Exceeded|Failed))\b/.exec(text)?.[1];
  return type ? type.split('.').at(-1) : 'other';
}

export function extractorOf(id) {
  const name = id.split('::').at(-1);
  return /^test_(.+?)(?:_webpage)?_\d+$/.exec(name)?.[1] ?? name.replace(/^test_/, '');
}

const pairClass = (native, wasm) => {
  if (native === 'pass' && wasm === 'pass') return 'bothPass';
  if (native === 'pass' && wasm === 'fail') return 'wasmOnlyFail';
  if (native === 'fail' && wasm === 'pass') return 'nativeOnlyFail';
  if (native === 'fail' && wasm === 'fail') return 'bothFail';
  return 'other';
};

const CLASS_LABELS = {
  bothPass: 'Both pass',
  wasmOnlyFail: 'Wasm-only failures',
  nativeOnlyFail: 'Native-only failures',
  bothFail: 'Both fail',
  other: 'Skipped or missing',
};

export function buildReport(ids, results) {
  const cases = ids.map((id) => {
    const name = id.split('::').at(-1);
    const row = { id, name, extractor: extractorOf(id) };
    for (const runtime of RUNTIMES) {
      const result = results[runtime].get(name);
      row[runtime] = result?.status ?? 'missing';
      if (result?.status === 'fail') {
        row[`${runtime}Reason`] = failureReason(result);
        row[`${runtime}Message`] = exceptionText(result).split('\n')[0].slice(0, 300);
      }
    }
    row.class = pairClass(row.native, row.wasm);
    return row;
  });

  const totals = Object.fromEntries(Object.keys(CLASS_LABELS).map((key) => [key, 0]));
  const byExtractor = new Map();
  for (const row of cases) {
    totals[row.class]++;
    if (!byExtractor.has(row.extractor)) {
      byExtractor.set(row.extractor, { extractor: row.extractor, cases: 0, ...Object.fromEntries(Object.keys(CLASS_LABELS).map((key) => [key, 0])) });
    }
    const entry = byExtractor.get(row.extractor);
    entry.cases++;
    entry[row.class]++;
  }

  // An extractor lands in one group, worst first
  const groupOf = (entry) => {
    if (entry.wasmOnlyFail) return 'wasmOnlyFail';
    if (entry.nativeOnlyFail) return 'nativeOnlyFail';
    if (entry.bothFail) return 'bothFail';
    if (entry.bothPass) return 'bothPass';
    return 'other';
  };
  const extractors = [...byExtractor.values()]
    .map((entry) => ({ ...entry, group: groupOf(entry) }))
    .sort((a, b) => b.wasmOnlyFail - a.wasmOnlyFail || b.nativeOnlyFail - a.nativeOnlyFail
      || b.bothFail - a.bothFail || a.extractor.localeCompare(b.extractor));
  const extractorTotals = Object.fromEntries(Object.keys(CLASS_LABELS).map((key) => [key, 0]));
  for (const entry of extractors) extractorTotals[entry.group]++;

  const wasmOnly = cases.filter((row) => row.class === 'wasmOnlyFail');
  const reasons = {};
  for (const row of wasmOnly) reasons[row.wasmReason] = (reasons[row.wasmReason] ?? 0) + 1;
  const wasmOnlyReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]);

  const missing = Object.fromEntries(RUNTIMES.map((runtime) => [runtime, cases.filter((row) => row[runtime] === 'missing').length]));
  return { cases, totals, extractors, extractorTotals, wasmOnlyReasons, missing };
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

export function summaryMarkdown(report, { full = false } = {}) {
  const { cases, totals, extractors, extractorTotals, wasmOnlyReasons, missing } = report;
  const lines = [
    '## Site parity',
    '',
    `${cases.length} test cases, ${extractors.length} extractors.`,
    '',
    '| Result | Cases | Extractors |',
    '| --- | ---: | ---: |',
    ...Object.entries(CLASS_LABELS).map(([key, label]) => `| ${label} | ${totals[key]} | ${extractorTotals[key]} |`),
    '',
  ];
  for (const runtime of RUNTIMES) {
    if (missing[runtime]) lines.push(`${missing[runtime]} of the cases have no ${runtime} result because their shard did not report.`, '');
  }

  lines.push('### Why wasm fails alone', '');
  if (wasmOnlyReasons.length) {
    lines.push('| Reason | Cases |', '| --- | ---: |', ...wasmOnlyReasons.map(([reason, count]) => `| ${cell(reason)} | ${count} |`));
  } else {
    lines.push('No wasm-only failures.');
  }
  lines.push('');

  const wasmOnly = cases.filter((row) => row.class === 'wasmOnlyFail');
  const shown = full ? wasmOnly : wasmOnly.slice(0, 25);
  if (shown.length) {
    lines.push('### Wasm-only failures', '', '| Case | Reason | Message |', '| --- | --- | --- |');
    for (const row of shown) lines.push(`| \`${row.name}\` | ${cell(row.wasmReason)} | ${cell(row.wasmMessage)} |`);
    if (shown.length < wasmOnly.length) lines.push('', `${wasmOnly.length - shown.length} more are in the report artifact.`);
    lines.push('');
  }

  if (full) {
    lines.push('### Native-only failures', '');
    const nativeOnly = cases.filter((row) => row.class === 'nativeOnlyFail');
    if (nativeOnly.length) {
      lines.push('| Case | Reason | Message |', '| --- | --- | --- |');
      for (const row of nativeOnly) lines.push(`| \`${row.name}\` | ${cell(row.nativeReason)} | ${cell(row.nativeMessage)} |`);
    } else {
      lines.push('None.');
    }
    lines.push('', '### Extractors', '', '| Extractor | Group | Cases | Both pass | Wasm only fails | Native only fails | Both fail | Other |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const entry of extractors) {
      lines.push(`| ${cell(entry.extractor)} | ${CLASS_LABELS[entry.group]} | ${entry.cases} | ${entry.bothPass} | ${entry.wasmOnlyFail} | ${entry.nativeOnlyFail} | ${entry.bothFail} | ${entry.other} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const csvField = (value) => (/[",\n]/.test(String(value ?? '')) ? `"${String(value).replace(/"/g, '""')}"` : String(value ?? ''));

export function casesCsv(cases) {
  const header = ['case', 'extractor', 'native', 'wasm', 'class', 'native_reason', 'wasm_reason', 'wasm_message'];
  const rows = cases.map((row) => [row.name, row.extractor, row.native, row.wasm, row.class, row.nativeReason, row.wasmReason, row.wasmMessage]);
  return [header, ...rows].map((fields) => fields.map(csvField).join(',')).join('\n') + '\n';
}

function main() {
  const ids = fs.readFileSync(idsFile, 'utf8').split('\n').filter(Boolean);
  const results = Object.fromEntries(RUNTIMES.map((runtime) => {
    const merged = new Map();
    const files = fs.existsSync(junitDir) ? fs.readdirSync(junitDir).filter((file) => file.startsWith(`${runtime}-`) && file.endsWith('.xml')) : [];
    for (const file of files) {
      for (const [name, result] of parseJunit(fs.readFileSync(path.join(junitDir, file), 'utf8'))) merged.set(name, result);
    }
    return [runtime, merged];
  }));

  const report = buildReport(ids, results);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'parity-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'parity-cases.csv'), casesCsv(report.cases));
  fs.writeFileSync(path.join(outDir, 'parity-report.md'), summaryMarkdown(report, { full: true }));
  process.stdout.write(summaryMarkdown(report));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
