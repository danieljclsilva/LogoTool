/// <reference lib="dom" />
/** Display-only enlarged workbench. Geometry and calibration are untouched. */
export function expandableWorkspace(host: HTMLElement, onChange: (expanded: boolean) => void = () => {}): { toggle(): void; close(): void; destroy(): void; expanded(): boolean } {
  let expanded = false;
  let previousOverflow = '';
  let previousFocus: HTMLElement | null = null;
  const close = (): void => {
    if (!expanded) return;
    expanded = false;
    host.classList.remove('station-expanded-workspace');
    host.removeAttribute('aria-modal');
    host.removeAttribute('role');
    document.body.style.overflow = previousOverflow;
    onChange(false);
    previousFocus?.focus({ preventScroll: true });
  };
  const keydown = (event: KeyboardEvent): void => {
    if (!expanded) return;
    if (event.key === 'Escape') { close(); event.preventDefault(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'))
      .filter((node) => node.getClientRects().length > 0);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { last?.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first?.focus(); event.preventDefault(); }
  };
  document.addEventListener('keydown', keydown);
  return {
    close,
    expanded: () => expanded,
    toggle() {
      if (expanded) { close(); return; }
      previousOverflow = document.body.style.overflow;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      expanded = true;
      host.classList.add('station-expanded-workspace');
      host.setAttribute('role', 'dialog');
      host.setAttribute('aria-modal', 'true');
      host.setAttribute('aria-label', 'Product workspace');
      document.body.style.overflow = 'hidden';
      onChange(true);
    },
    destroy() { close(); document.removeEventListener('keydown', keydown); },
  };
}
