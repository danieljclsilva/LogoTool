/**
 * Minimal portable GLB container parser.
 *
 * Pure ES2022 with no imports: no Node fs/crypto, no browser/Three.js APIs.
 * UTF-8 decoding uses the standard fatal TextDecoder so the module stays dependency-free
 * on every runtime (Node, browser bundle, offline `file://` package).
 *
 * Layout handled (glTF 2.0 binary container):
 *   header: magic `glTF` + version uint32LE + declared length uint32LE,
 *   then a JSON chunk (`JSON`, required first), then an optional BIN chunk
 *   (`BIN\0`). Anything else is rejected — ingestion only accepts the
 *   self-contained subset (see `./validate.js`).
 *
 * The parser never mutates `bytes`; all reads go through a DataView window.
 */

export interface GlbParsed {
  json: unknown;
  binaryByteOffset: number;
  jsonByteLength: number;
  binChunkLength: number | null;
  warnings: string[];
}

/** Coded parse failure: `{ code, path?, message }` per the asset contract. */
export interface GlbCodedError extends Error {
  code: string;
  path?: string;
}

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_LENGTH = 12;
const CHUNK_HEADER_LENGTH = 8;

function fail(code: string, message: string, path: string): never {
  const error = new Error(message) as GlbCodedError;
  error.code = code;
  error.path = path;
  throw error;
}

/**
 * Strict UTF-8 decoder; invalid bytes are rejected even within JSON strings.
 */
function decodeUtf8(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(start, end));
}

export function parseGlb(bytes: Uint8Array): GlbParsed {
  if (!(bytes instanceof Uint8Array)) {
    fail("glb-bad-input", "parseGlb expects a Uint8Array.", "");
  }
  if (bytes.length < HEADER_LENGTH) {
    fail("glb-too-small", `GLB is ${bytes.length} bytes; header needs 12.`, "");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    fail("glb-bad-magic", "GLB magic is not `glTF`.", "");
  }
  const version = view.getUint32(4, true);
  if (version !== GLB_VERSION) {
    fail(
      "glb-unsupported-version",
      `GLB version ${version} is unsupported; only version 2 is accepted.`,
      "",
    );
  }
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.length) {
    fail(
      "glb-length-mismatch",
      `GLB declares ${declaredLength} bytes but carries ${bytes.length}.`,
      "",
    );
  }
  if (bytes.length < HEADER_LENGTH + CHUNK_HEADER_LENGTH) {
    fail("glb-missing-json-chunk", "GLB has no JSON chunk.", "");
  }
  const jsonChunkLength = view.getUint32(HEADER_LENGTH, true);
  if (jsonChunkLength % 4 !== 0) fail('glb-chunk-alignment', 'JSON chunk must be aligned to four bytes.', '');
  const jsonChunkType = view.getUint32(HEADER_LENGTH + 4, true);
  if (jsonChunkType !== CHUNK_JSON) {
    fail(
      "glb-bad-json-chunk-type",
      "First GLB chunk is not JSON; the JSON chunk must come first.",
      "",
    );
  }
  const jsonEnd = HEADER_LENGTH + CHUNK_HEADER_LENGTH + jsonChunkLength;
  if (jsonEnd > bytes.length) {
    fail(
      "glb-chunk-out-of-bounds",
      `JSON chunk of ${jsonChunkLength} bytes overruns the ${bytes.length}-byte container.`,
      "",
    );
  }
  const jsonByteLength = jsonChunkLength;
  let json: unknown;
  try {
    json = JSON.parse(
      decodeUtf8(bytes, HEADER_LENGTH + CHUNK_HEADER_LENGTH, jsonEnd),
    );
  } catch {
    fail("glb-invalid-json", "GLB JSON chunk is not valid UTF-8 JSON.", "");
  }

  const warnings: string[] = [];
  let binChunkLength: number | null = null;
  let binaryByteOffset = jsonEnd;
  if (jsonEnd < bytes.length) {
    if (bytes.length - jsonEnd < CHUNK_HEADER_LENGTH) {
      fail(
        "glb-chunk-out-of-bounds",
        "Trailing bytes after the JSON chunk are too short for a chunk header.",
        "",
      );
    }
    const binLength = view.getUint32(jsonEnd, true);
    if (binLength % 4 !== 0) fail('glb-chunk-alignment', 'BIN chunk must be aligned to four bytes.', '');
    const binType = view.getUint32(jsonEnd + 4, true);
    if (binType !== CHUNK_BIN) {
      fail(
        "glb-unexpected-chunk",
        "Second GLB chunk is not BIN; only JSON then BIN chunks are accepted.",
        "",
      );
    }
    const binEnd = jsonEnd + CHUNK_HEADER_LENGTH + binLength;
    if (binEnd > bytes.length) {
      fail(
        "glb-chunk-out-of-bounds",
        `BIN chunk of ${binLength} bytes overruns the ${bytes.length}-byte container.`,
        "",
      );
    }
    if (binEnd !== bytes.length) {
      fail(
        "glb-extra-data",
        "GLB has trailing bytes after the BIN chunk.",
        "",
      );
    }
    binChunkLength = binLength;
    binaryByteOffset = jsonEnd + CHUNK_HEADER_LENGTH;
    if (binLength === 0) {
      warnings.push("BIN chunk is empty.");
    }
  }
  return { json, binaryByteOffset, jsonByteLength, binChunkLength, warnings };
}
