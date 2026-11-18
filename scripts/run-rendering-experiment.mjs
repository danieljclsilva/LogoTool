import ts from 'typescript';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { experimentSettings } from './experiment-settings.mjs';

const settings = experimentSettings();
if (!settings.arm) throw new Error('Set E2E_EXPERIMENT_ARM for this opt-in runner.');
const project = process.argv[2];
if (!['chromium', 'chrome', 'msedge'].includes(project)) throw new Error('Expected a browser project.');
const shard = process.env.TEST_SHARD ?? '1/1';
if (!/^\d+\/\d+$/.test(shard)) throw new Error('Expected TEST_SHARD as index/total.');
const root = resolve('ci-evidence/experiment-source');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await cp(resolve('e2e'), join(root, 'e2e'), { recursive: true });
await symlink(resolve('src'), join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
const manifest = { ...settings, project, shard, retries: 0, rendering: 'continuous',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  files: [], timingSites: [],
  budgets: ['default test', 'test.setTimeout overrides', 'default expect', 'explicit timeout options', 'default action/navigation setters'],
  fixedDelays: 'Timers and waitForTimeout durations retain their original values.' };
const hash = text => createHash('sha256').update(text).digest('hex');
const printer = ts.createPrinter();
async function prepare(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await prepare(path); continue; }
    const original = await readFile(path);
    const name = relative(join(root, 'e2e'), path).replaceAll('\\', '/');
    let derived = original;
    if (entry.name.endsWith('.ts')) {
      const source = ts.createSourceFile(path, original.toString(), ts.ScriptTarget.Latest, true);
      const result = ts.transform(source, [context => {
        const multiply = expression => ts.factory.createBinaryExpression(ts.factory.createParenthesizedExpression(expression), ts.SyntaxKind.AsteriskToken, ts.factory.createNumericLiteral(settings.timeoutMultiplier));
        const record = node => manifest.timingSites.push({ file: name, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: node.getText(source) });
        const visit = node => {
          if (ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll(/["']/g, '') === 'timeout') {
            record(node);
            return ts.factory.updatePropertyAssignment(node, node.name, multiply(node.initializer));
          }
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['setTimeout', 'setDefaultTimeout', 'setDefaultNavigationTimeout'].includes(node.expression.name.text) && node.arguments.length === 1) {
            record(node);
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [multiply(node.arguments[0])]);
          }
          return ts.visitEachChild(node, visit, context);
        };
        return node => ts.visitNode(node, visit);
      }]);
      derived = Buffer.from(printer.printFile(result.transformed[0]));
      result.dispose();
      await writeFile(path, derived);
    }
    manifest.files.push({ path: `e2e/${name}`, originalSha256: hash(original), derivedSha256: hash(derived) });
  }
}
await prepare(join(root, 'e2e'));
await mkdir(resolve('ci-evidence', project), { recursive: true });
await writeFile(resolve('ci-evidence', project, 'experiment-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const env = { ...process.env, E2E_EXPERIMENT_TEST_DIR: join(root, 'e2e'),
  E2E_TIMEOUT_MULTIPLIER: String(settings.timeoutMultiplier), E2E_WORKERS: String(settings.workers) };
const command = ['node_modules/@playwright/test/cli.js', 'test', `--project=${project}`, `--workers=${settings.workers}`, '--retries=0', `--shard=${shard}`, '--reporter=line,json,html'];
if (process.env.E2E_EXPERIMENT_LIST_ONLY === '1') command.push('--list');
const result = spawnSync(process.execPath, command, { env, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
