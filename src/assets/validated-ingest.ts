import { validateBytes } from 'gltf-validator';
import { ingestAsset } from './provenance.js';
import type { IngestAssetInput, IngestAssetResult } from './provenance.js';
import type { ValidateSelfContainedOptions } from './validate.js';

/** Policy gate first, then Khronos structural/binary validation. No resource IO. */
export async function ingestValidatedAsset(input: IngestAssetInput, options?: ValidateSelfContainedOptions): Promise<IngestAssetResult> {
  const result = ingestAsset(input, options);
  if (result.issues.some(issue => !issue.code.endsWith('-advisory'))) return result;
  const report = await validateBytes(input.bytes, {
    format: 'glb', writeTimestamp: false, maxIssues: 100,
    externalResourceFunction: async () => { throw new Error('External resources are forbidden.'); },
  });
  for (const issue of report.issues.messages) {
    if (issue.severity === 0) result.issues.push({code: `gltf-${issue.code}`, path: issue.pointer ?? '', message: issue.message});
  }
  if (report.issues.numErrors > 0 && !result.issues.some(issue => issue.code.startsWith('gltf-'))) {
    result.issues.push({code: 'gltf-validation-errors', path: '', message: 'GLB failed structural validation; the diagnostic limit was reached.'});
  }
  return result;
}
