/// <reference lib="dom" />
export interface CanvasContextPanelOptions {
  host: HTMLElement;
  toolbar: HTMLElement;
  id: string;
  label: string;
  title?: string;
  onVisibilityChange?(): void;
}
export interface CanvasContextPanel {
  readonly element: HTMLElement;
  readonly content: HTMLElement;
  readonly trigger: HTMLButtonElement;
  open(title?: string): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}
export function createCanvasContextPanel(options: CanvasContextPanelOptions): CanvasContextPanel {
  const host = options.host;
  const toolbar = options.toolbar;
  const panelId = options.id;
  const label = options.label;

  // Positioned ancestor for the absolute popover; touch host only when static.
  const computedPosition =
    typeof getComputedStyle === 'function' ? getComputedStyle(host).position : host.style.position;
  if (!computedPosition || computedPosition === 'static') {
    host.style.position = 'relative';
  }

  const element = document.createElement('div');
  element.id = panelId;
  element.className = 'canvas-context-panel';
  element.setAttribute('data-canvas-context', 'panel');
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', label);
  element.hidden = true;
  element.setAttribute('data-canvas-context-section', label);

  // Small on-canvas popover, bottom-left. Inline layout only; colors/type via
  // existing CSS var tokens. No overlay: pointer events only inside the panel.
  element.style.position = 'absolute';
  element.style.left = '12px';
  element.style.bottom = '12px';
  element.style.zIndex = '6';
  element.style.maxWidth = 'min(340px, calc(100% - 24px))';
  element.style.maxHeight = 'min(60vh, calc(100% - 24px))';
  element.style.overflow = 'auto';
  element.style.scrollbarGutter = 'stable';
  element.style.pointerEvents = 'auto';
  element.style.background = '#fff';
  element.style.color = 'var(--ink)';
  element.style.border = '1px solid var(--line)';
  element.style.fontFamily = 'system-ui, sans-serif';

  const header = document.createElement('div');
  header.style.position = 'sticky';
  header.style.top = '0';
  header.style.zIndex = '2';
  header.style.background = '#fff';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.justifyContent = 'space-between';
  header.style.gap = '8px';

  const title = document.createElement('span');
  title.setAttribute('data-canvas-context-title', '');
  title.textContent = options.title ?? label;

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.setAttribute('data-canvas-context-dismiss', '');
  dismiss.setAttribute('aria-label', 'Dismiss panel');
  dismiss.textContent = 'Close \u00d7';
  dismiss.style.color = 'var(--ink)';
  dismiss.style.border = '1px solid var(--line)';

  header.appendChild(title);
  header.appendChild(dismiss);

  const body = document.createElement('div');
  body.setAttribute('data-canvas-context-body', '');

  element.appendChild(header);
  element.appendChild(body);
  host.appendChild(element);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = label;
  trigger.setAttribute('aria-controls', panelId);
  trigger.setAttribute('aria-expanded', 'false');
  toolbar.appendChild(trigger);

  const listeners = new AbortController();
  const signal = listeners.signal;
  let destroyed = false;

  function syncTrigger(): void {
    trigger.setAttribute('aria-expanded', element.hidden ? 'false' : 'true');
  }

  document.addEventListener('canvas-context-open', (event) => {
    if ((event as CustomEvent).detail !== element) close();
  }, { signal });

  function open(titleText?: string): void {
    document.dispatchEvent(new CustomEvent('canvas-context-open', { detail: element }));
    if (titleText !== undefined) {
      title.textContent = titleText;
    }
    element.setAttribute('data-canvas-context-section', titleText ?? options.title ?? label);
    element.setAttribute('aria-label', titleText ?? options.title ?? label);
    element.hidden = false;
    element.classList.add('is-open');
    syncTrigger();
    options.onVisibilityChange?.();
  }

  function close(): void {
    element.hidden = true;
    element.classList.remove('is-open');
    syncTrigger();
    options.onVisibilityChange?.();
  }

  function isOpen(): boolean {
    return !element.hidden;
  }

  function onEscape(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Escape') return;
    if (event.defaultPrevented) return;
    if (!isOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    listeners.abort();
    if (trigger.parentNode) {
      trigger.parentNode.removeChild(trigger);
    }
    if (element.parentNode) {
      element.parentNode.removeChild(element);
    }
  }

  trigger.addEventListener('click', () => {
    if (isOpen()) {
      close();
    } else {
      open();
    }
  }, { signal });

  dismiss.addEventListener('click', () => {
    close();
  }, { signal });

  // Bubble within the canvas host: edit cancellation wins first, then this
  // panel, then the enclosing enlarged workspace. No document listener.
  host.addEventListener('keydown', onEscape, { signal });
  trigger.addEventListener('keydown', onEscape, { signal });

  dismiss.addEventListener(
    'focus',
    () => {
      dismiss.style.outline = '2px solid var(--focus)';
    },
    { signal },
  );

  const panel: CanvasContextPanel = {
    element,
    content: body,
    trigger,
    open,
    close,
    isOpen,
    destroy,
  };

  return panel;
}
