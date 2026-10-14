import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalize, contentDigest, contentEnvelope } from '../src/core/index.js';
import type { ProjectDocument } from '../src/core/index.js';
import { createWebCryptoProjectHasher } from '../src/ui/shared/browser-hasher.js';

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'examples/projects/project-multi.project.json'), 'utf8'),
) as ProjectDocument;

const nodeSha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('Web Crypto project hasher bridge', () => {
  it('prepares exact canonical content text and rejects every unprepared text', async () => {
    const hasher = createWebCryptoProjectHasher();
    const text = canonicalize(contentEnvelope(fixture));
    assert.throws(() => hasher.sha256Hex(text), /no prepared digest/);

    const digest = await hasher.prepareProject(fixture);
    assert.equal(digest, nodeSha256(text));
    assert.equal(hasher.sha256Hex(text), digest);
    assert.equal(contentDigest(fixture, hasher.sha256Hex), digest);

    const changed = structuredClone(fixture);
    changed.instructions = `${changed.instructions ?? ''} revised`;
    const changedText = canonicalize(contentEnvelope(changed));
    assert.notEqual(changedText, text);
    assert.throws(() => hasher.sha256Hex(changedText), /no prepared digest/);
    assert.equal(await hasher.prepareProject(changed), nodeSha256(changedText));
    assert.equal(hasher.sha256Hex(changedText), nodeSha256(changedText));
  });

  it('hashes exact package bytes through asynchronous Web Crypto', async () => {
    const hasher = createWebCryptoProjectHasher();
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    assert.equal(await hasher.sha256Bytes(bytes), createHash('sha256').update(bytes).digest('hex'));
  });
});
