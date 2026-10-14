/**
 * Self-contained issued-HTML bootstrap for the customer editor.
 *
 * Detects a project package embedded by `src/packaging/self-contained-html`
 * and loads it through the same atomic pipeline as a user-chosen file. If the
 * embedded data is missing, malformed, or fails validation, the chooser remains
 * usable and a useful error is shown in the status line.
 */

import {
  EMBEDDED_PROJECT_SCRIPT_ID,
  decodeEmbeddedProjectBase64,
} from '../../packaging/self-contained-html/index.js';

const EMBEDDED_FILE_NAME = 'embedded-issued.logo-project';

export interface CustomerLoadProjectBytes {
  (bytes: Uint8Array, fileName: string): Promise<void>;
}

function setStatus(message: string): void {
  if (typeof document === 'undefined') return;
  const status = document.querySelector<HTMLElement>('[data-customer-hook="status"]');
  if (status) status.textContent = message;
}

/**
 * If the host document contains the embedded issued project, decode it and
 * load it atomically. The load is asynchronous, so a user-initiated file
 * replacement that starts while this load is pending will win because the
 * shared load pipeline tracks a monotonic generation.
 */
export function runCustomerSelfContainedBootstrap(loadProjectBytes: CustomerLoadProjectBytes): void {
  if (typeof document === 'undefined') return;
  const elements = document.querySelectorAll(`[id="${EMBEDDED_PROJECT_SCRIPT_ID}"]`);
  if (elements.length === 0) return; // Hybrid mode intentionally has no payload.
  const element = elements[0]!;
  if (elements.length !== 1 || element.tagName !== 'SCRIPT' || element.getAttribute('type') !== 'application/x-logo-project') {
    setStatus('Embedded project data block is invalid or duplicated. Use Choose Project to begin.');
    return;
  }
  const base64 = element.textContent ?? '';
  if (!base64) {
    setStatus('Embedded project data is empty. Use Choose Project or drop a .logo-project package to begin.');
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = decodeEmbeddedProjectBase64(base64);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(`Embedded project data could not be decoded. ${detail}`);
    return;
  }
  void loadProjectBytes(bytes, EMBEDDED_FILE_NAME);
}
