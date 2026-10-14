import { canonicalize, contentEnvelope } from '../../core/index.js';
import type { ProjectDocument, Sha256HexFn } from '../../core/index.js';
import type { ProjectPackageSha256 } from '../../packaging/project-package/index.js';

export interface WebCryptoProjectHasher {
  /** Strict synchronous lookup used by the core's digest APIs. */
  sha256Hex: Sha256HexFn;
  /** Asynchronous SHA-256 for exact archive bytes. */
  sha256Bytes: ProjectPackageSha256;
  /** Hash and register the exact canonical project content text. */
  prepareProject(project: ProjectDocument): Promise<string>;
}

/**
 * Bridge browser Web Crypto to core APIs that require a synchronous injected
 * hasher. Only canonical project texts explicitly prepared here can be read
 * synchronously; arbitrary inputs fail closed.
 */
const MAX_PREPARED_PROJECT_TEXTS = 8;

export function createWebCryptoProjectHasher(): WebCryptoProjectHasher {
  const prepared = new Map<string, string>();

  const digest = async (bytes: Uint8Array): Promise<string> => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this browser');
    const owned = new Uint8Array(bytes).buffer;
    const result = await subtle.digest('SHA-256', owned);
    return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };

  const sha256Hex: Sha256HexFn = (canonicalText) => {
    const value = prepared.get(canonicalText);
    if (value === undefined) {
      throw new Error('Web Crypto project hasher has no prepared digest for this canonical text');
    }
    return value;
  };

  return {
    sha256Hex,
    sha256Bytes: digest,
    async prepareProject(project) {
      const text = canonicalize(contentEnvelope(project));
      const value = await digest(new TextEncoder().encode(text));
      if (!prepared.has(text) && prepared.size >= MAX_PREPARED_PROJECT_TEXTS) {
        const oldest = prepared.keys().next();
        if (!oldest.done) prepared.delete(oldest.value);
      }
      prepared.set(text, value);
      return value;
    },
  };
}
