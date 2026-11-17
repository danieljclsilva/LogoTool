import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const project = process.argv[2];
if (!['chromium', 'chrome', 'msedge'].includes(project)) throw new Error('Expected a browser project.');
const directory = resolve('ci-evidence', project);
await mkdir(directory, { recursive: true });
const escape = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
let report;
try {
  report = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const failures = [];
function visit(suite, parents = []) {
  const path = [...parents, suite.title].filter(Boolean);
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      if (test.status !== 'unexpected' && test.status !== 'flaky') continue;
      failures.push({
        file: spec.file, title: [...path, spec.title].join(' › '), status: test.status,
        attempts: test.results.map(result => ({
          status: result.status, errors: result.errors.map(error => error.message ?? String(error)),
        })),
      });
    }
  }
  for (const child of suite.suites ?? []) visit(child, path);
}
for (const suite of report?.suites ?? []) visit(suite);
await writeFile(resolve(directory, 'failures.json'), JSON.stringify({ project,
  shard: process.env.TEST_SHARD ?? '1/1', stats: report?.stats ?? null, failures }, null, 2) + '\n');
const heading = `### ${project} shard ${process.env.TEST_SHARD ?? '1/1'} test results\n\n`;
let markdown = heading;
if (!report) {
  markdown += 'Playwright JSON is unavailable. Inspect setup or cancellation logs.\n';
} else {
  const stats = report.stats;
  markdown += `${stats.expected} passed, ${stats.unexpected} failed, ${stats.skipped} skipped, ${stats.flaky} flaky.\n\n`;
  if (failures.length) {
    markdown += '| Failing case | Error |\n| --- | --- |\n';
    for (const failure of failures) {
      const error = failure.attempts.flatMap(attempt => attempt.errors).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
      markdown += `| ${escape(failure.title)} | ${escape(error.split('\n')[0]).slice(0, 400)} |\n`;
    }
  }
}
await writeFile(resolve(directory, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
process.stdout.write(markdown);
