/**
 * Browser-independent self-contained HTML packaging.
 *
 * Embeds a `.logo-project` package as a base64 payload inside a script tag
 * within an HTML template. The generated HTML is deterministic for the same
 * inputs. Embedded bytes are treated as inert package bytes and are never
 * executed or rendered.
 */

import { PROJECT_PACKAGE_LIMITS } from "../project-package/index.js";

export const EMBEDDED_PROJECT_SCRIPT_ID = "__logoEmbeddedProject" as const;
export const EMBEDDED_PROJECT_MARKER = "<!-- EMBEDDED_LOGO_PROJECT -->" as const;

export const MAX_EMBEDDED_PROJECT_BASE64_CHARS = 4 * Math.ceil(PROJECT_PACKAGE_LIMITS.maxArchiveBytes / 3);

const SCRIPT_OPEN = `<script id="${EMBEDDED_PROJECT_SCRIPT_ID}" type="application/x-logo-project">`;
const SCRIPT_CLOSE = "</script>";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE_BY_CHARACTER: Record<string, number> = {};
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_VALUE_BY_CHARACTER[BASE64_ALPHABET[index]!] = index;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytesToBase64(bytes: Uint8Array): string {
  // Bound temporary string construction rather than retaining one rope node per byte.
  const chunks: string[] = [];
  const chunkBytes = 12_288; // divisible by three
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    let chunk = '';
    const end = Math.min(bytes.length, start + chunkBytes);
    for (let index = start; index < end; index += 3) {
      const byte1 = bytes[index]!;
      const byte2 = bytes[index + 1];
      const byte3 = bytes[index + 2];
      const bitmap = (byte1 << 16) | ((byte2 ?? 0) << 8) | (byte3 ?? 0);
      chunk += BASE64_ALPHABET[(bitmap >> 18) & 0x3f]!;
      chunk += BASE64_ALPHABET[(bitmap >> 12) & 0x3f]!;
      chunk += byte2 === undefined ? '=' : BASE64_ALPHABET[(bitmap >> 6) & 0x3f]!;
      chunk += byte3 === undefined ? '=' : BASE64_ALPHABET[bitmap & 0x3f]!;
    }
    chunks.push(chunk);
  }
  return chunks.join('');
}

/** Strict, bounded standard-base64 decoding shared by packaging and the browser. */
export function decodeEmbeddedProjectBase64(base64: string): Uint8Array {
  if (base64.length > MAX_EMBEDDED_PROJECT_BASE64_CHARS) {
    throw new Error('self-contained html: embedded base64 exceeds archive size limit');
  }
  if (base64.length === 0) {
    throw new Error('self-contained html: embedded base64 is empty');
  }
  if (base64.length % 4 !== 0) {
    throw new Error('self-contained html: embedded base64 length is not a multiple of 4');
  }
  if (!BASE64_PATTERN.test(base64)) {
    throw new Error('self-contained html: embedded base64 contains invalid characters');
  }
  const padCount = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const outputLength = base64.length * 3 / 4 - padCount;
  if (outputLength > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    throw new Error('self-contained html: embedded base64 exceeds archive size limit');
  }
  const lastValue = BASE64_VALUE_BY_CHARACTER[base64[base64.length - padCount - 1]!]!;
  if ((padCount === 2 && (lastValue & 15) !== 0) || (padCount === 1 && (lastValue & 3) !== 0)) {
    throw new Error('self-contained html: embedded base64 has nonzero padding bits');
  }
  const output = new Uint8Array(outputLength);
  let outputIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < base64.length - padCount; index += 1) {
    buffer = (buffer << 6) | BASE64_VALUE_BY_CHARACTER[base64[index]!]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return output;
}

/**
 * Embed a `.logo-project` package inside an HTML template.
 *
 * The HTML must contain exactly one `EMBEDDED_PROJECT_MARKER`. The marker is
 * replaced with a script tag containing the package bytes encoded as standard
 * base64 without line breaks.
 */
export function createSelfContainedHtml(input: {
  html: string | Uint8Array;
  projectPackage: Uint8Array;
}): Uint8Array {
  if (!(input.projectPackage instanceof Uint8Array)) {
    throw new Error("self-contained html: projectPackage must be a Uint8Array");
  }
  if (input.projectPackage.length === 0) {
    throw new Error("self-contained html: projectPackage must not be empty");
  }
  if (input.projectPackage.length > PROJECT_PACKAGE_LIMITS.maxArchiveBytes) {
    throw new Error(
      `self-contained html: projectPackage exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes`,
    );
  }

  const html = typeof input.html === "string" ? input.html : decoder.decode(input.html);
  const markerIndex = html.indexOf(EMBEDDED_PROJECT_MARKER);
  if (markerIndex === -1) {
    throw new Error("self-contained html: HTML must contain exactly one embedded project marker");
  }
  if (html.indexOf(EMBEDDED_PROJECT_MARKER, markerIndex + EMBEDDED_PROJECT_MARKER.length) !== -1) {
    throw new Error("self-contained html: HTML contains multiple embedded project markers");
  }

  const base64 = bytesToBase64(input.projectPackage);
  const replacement = `${SCRIPT_OPEN}${base64}${SCRIPT_CLOSE}`;
  const outputHtml = html.replace(EMBEDDED_PROJECT_MARKER, replacement);
  return encoder.encode(outputHtml);
}

/**
 * Extract an embedded `.logo-project` package from self-contained HTML.
 *
 * Returns the original package bytes, or `null` if the embedded script tag is
 * missing. Throws if the script id is duplicated or the base64 payload is
 * malformed.
 */
export function extractEmbeddedProjectPackage(html: string | Uint8Array): Uint8Array | null {
  const htmlString = typeof html === "string" ? html : decoder.decode(html);
  const openIndex = htmlString.indexOf(SCRIPT_OPEN);
  if (openIndex === -1) {
    return null;
  }

  const afterOpen = openIndex + SCRIPT_OPEN.length;
  const closeIndex = htmlString.indexOf(SCRIPT_CLOSE, afterOpen);
  if (closeIndex === -1) {
    throw new Error("self-contained html: embedded project script tag is not closed");
  }

  if (htmlString.indexOf(SCRIPT_OPEN, afterOpen) !== -1) {
    throw new Error("self-contained html: embedded project script id is duplicated");
  }

  const base64 = htmlString.slice(afterOpen, closeIndex);
  return decodeEmbeddedProjectBase64(base64);
}
