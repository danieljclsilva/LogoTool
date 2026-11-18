import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const project = process.argv[2];
if (!['chromium', 'chrome', 'msedge'].includes(project)) throw new Error('Expected a browser project.');
const directory = resolve('ci-evidence', project);
const report = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
const screens = [];
function visit(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results) {
        for (const item of result.attachments ?? []) {
          if (!item.name.startsWith('rendering-profile-') || !item.body) continue;
          const sample = JSON.parse(Buffer.from(item.body, 'base64').toString());
          screens.push({ ...sample, testStatus: test.status });
        }
      }
    }
  }
  for (const child of suite.suites ?? []) visit(child);
}
for (const suite of report.suites) visit(suite);
await writeFile(resolve(directory, 'idle-profile.json'), JSON.stringify({ project, stats: report.stats, screens }, null, 2) + '\n');
let markdown = `### Experiment 0 — ${project}\n\n`;
markdown += '| Screen | RAF callbacks pending | Contexts drawing | Hidden/offscreen drawing | Frames/s | Long tasks | Context loss events |\n| --- | --- | --- | --- | --- | --- | --- |\n';
for (const { screen, measurement } of screens) {
  const drawing = measurement.contexts.filter(context => context.renderedFrames > 0);
  const hidden = drawing.filter(context => !context.layoutVisible || !context.connected || !context.inViewport);
  const fps = drawing.reduce((sum, context) => sum + context.renderedRafFramesPerSecond, 0);
  markdown += `| ${screen} | ${measurement.liveRafCallbacks} | ${drawing.length} | ${hidden.length} | ${fps.toFixed(1)} | ${measurement.longTasks} | ${measurement.contextEvents.filter(event => event.event === 'webglcontextlost').length} |\n`;
}
markdown += '\nFrame counts represent RAF callbacks issuing GL draws. Inspect per-context data, explicit clears, lifecycle events and failed/incomplete tests in the retained artifacts.\n';
await writeFile(resolve(directory, 'idle-profile.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
process.stdout.write(markdown);
