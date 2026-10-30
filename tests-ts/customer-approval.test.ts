import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProjectDocument } from '../src/core/types.js';
import { describeApprovalChanges } from '../src/ui/internal-builder/customer-approval.js';
const fixture=()=>JSON.parse(readFileSync(new URL('../../examples/projects/project-multi.project.json',import.meta.url),'utf8')) as ProjectDocument;
test('note-only customer return shows exact before and after logo instructions',()=>{
  const issued=fixture(),returned=structuredClone(issued);
  issued.configurations[0]!.placements[0]!.instructions='Before <script> remains inert';
  returned.configurations[0]!.placements[0]!.instructions='Move 10 mm below the pocket seam.';
  const lines=describeApprovalChanges(issued,returned,'test-digest').groups.flatMap(g=>g.lines);
  assert(lines.some(l=>l.includes('instructions changed')));
  assert(lines.includes('Before: Before <script> remains inert'));
  assert(lines.includes('After: Move 10 mm below the pocket seam.'));
});
test('method and rotation changes are explicit in customer return summary',()=>{
  const issued=fixture(),returned=structuredClone(issued);
  const p=returned.configurations[0]!.placements[0]!;p.method='print';p.rotationDeg=15;
  const lines=describeApprovalChanges(issued,returned,'test-digest').groups.flatMap(g=>g.lines).join('\n');
  assert.match(lines,/method embroidery → print/);assert.match(lines,/rotation 0\.0° → 15\.0°/);
});
