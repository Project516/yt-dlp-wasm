// Turns live-results/*.json into summary.md for the job summary and failures.md for the issue
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(import.meta.dirname, '../live-results');
const CASES = [
  { name: 'audio', label: 'Audio mp3 from archive.org', blocking: true },
  { name: 'video', label: 'Video from archive.org', blocking: true },
  { name: 'youtube', label: 'Audio from YouTube', blocking: false },
];

const rows = CASES.map((entry) => {
  const file = path.join(dir, `${entry.name}.json`);
  const result = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8'))
    : { status: 'fail', detail: 'No result was recorded. The test did not reach this case.', seconds: 0 };
  return { ...entry, ...result };
});

const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const summary = [
  '## Live demo smoke test',
  '',
  '| Case | Kind | Result | Time | Detail |',
  '| --- | --- | --- | ---: | --- |',
  ...rows.map((row) => `| ${row.label} | ${row.blocking ? 'blocking' : 'informational'} | ${row.status === 'pass' ? 'pass' : row.blocking ? 'FAIL' : 'fail, not blocking'} | ${row.seconds}s | ${cell(row.detail)} |`),
  '',
].join('\n');

const failures = rows
  .filter((row) => row.blocking && row.status !== 'pass')
  .map((row) => `- ${row.label}: ${cell(row.detail)}`)
  .join('\n');

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.md'), summary);
fs.writeFileSync(path.join(dir, 'failures.md'), failures);
process.stdout.write(summary);
