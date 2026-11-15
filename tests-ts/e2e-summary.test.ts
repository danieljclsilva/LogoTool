import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('CI summary records failing titles, attempts and missing reports', async () => {
  const script = resolve('scripts/summarize-e2e.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'logotool-summary-'));
  try {
    const output = join(directory, 'ci-evidence', 'chrome');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'results.json'), JSON.stringify({
      stats: { expected: 2, unexpected: 1, skipped: 0, flaky: 0 },
      suites: [{ title: 'offline', specs: [{ file: 'fixture.spec.ts', title: 'failure | title',
        tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message: 'Expected 10\nReceived 11' }] }] }],
      }] }],
    }));
    const summary = join(directory, 'job-summary.md');
    await writeFile(summary, 'Preflight passed\n');
    const run = () => execFileSync(process.execPath, [script, 'chrome'], {
      cwd: directory, env: { ...process.env, TEST_SHARD: '1/2', GITHUB_STEP_SUMMARY: summary },
    });
    run();
    const markdown = await readFile(summary, 'utf8');
    assert.match(markdown, /^Preflight passed/);
    assert.match(markdown, /failure \\\| title/);
    assert.match(markdown, /Expected 10/);
    const failures = JSON.parse(await readFile(join(output, 'failures.json'), 'utf8'));
    assert.equal(failures.shard, '1/2');
    assert.equal(failures.failures[0].attempts[0].errors[0], 'Expected 10\nReceived 11');
    await rm(join(output, 'results.json'));
    run();
    assert.match(await readFile(summary, 'utf8'), /JSON is unavailable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
