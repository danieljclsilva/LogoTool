// Installed only by the opt-in Experiment 0 browser probe.
export function installRenderingProbe(): void {
  type ContextRecord = {
    id: number;
    context: WeakRef<WebGLRenderingContext>;
    canvas: WeakRef<HTMLCanvasElement>;
    draws: number;
    clearPasses: number;
    renderedFrames: number;
    lastFrame: number;
    outsideRafClearPasses: number;
    renderer: string;
  };
  const contexts = new Map<number, ContextRecord>();
  const contextIds = new WeakMap<object, number>();
  const callbackIds = new WeakMap<FrameRequestCallback, number>();
  const callbacks = new Map<number, { name: string; calls: number; pending: number }>();
  const pending = new Map<number, number>();
  const contextEvents: Array<{ id: number; event: string; time: number }> = [];
  let nextContext = 0;
  let nextCallback = 0;
  let frame = 0;
  let inFrame = false;
  let start = performance.now();
  let longTasks = 0;
  let longTaskMs = 0;
  let longestTaskMs = 0;
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
  if (longTasksSupported) {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < start) continue;
        longTasks += 1;
        longTaskMs += entry.duration;
        longestTaskMs = Math.max(longestTaskMs, entry.duration);
      }
    }).observe({ type: 'longtask' });
  }
  const originalRaf = window.requestAnimationFrame.bind(window);
  const originalCancel = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => {
    let callbackId = callbackIds.get(callback);
    if (callbackId === undefined) {
      callbackId = ++nextCallback;
      callbackIds.set(callback, callbackId);
      callbacks.set(callbackId, { name: callback.name || 'anonymous', calls: 0, pending: 0 });
    }
    const id = callbackId;
    const record = callbacks.get(id)!;
    record.pending += 1;
    const handle = originalRaf(time => {
      pending.delete(handle);
      record.pending -= 1;
      record.calls += 1;
      frame += 1;
      inFrame = true;
      try { callback(time); } finally { inFrame = false; }
    });
    pending.set(handle, id);
    return handle;
  };
  window.cancelAnimationFrame = handle => {
    const id = pending.get(handle);
    if (id !== undefined) {
      callbacks.get(id)!.pending -= 1;
      pending.delete(handle);
    }
    originalCancel(handle);
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true, writable: true,
    value: function (this: HTMLCanvasElement, ...args: unknown[]) {
      const context = Reflect.apply(getContext, this, args) as RenderingContext | null;
      if (context && (args[0] === 'webgl' || args[0] === 'webgl2' || args[0] === 'experimental-webgl') && !contextIds.has(context)) {
        const gl = context as WebGLRenderingContext;
        const id = ++nextContext;
        contextIds.set(gl, id);
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        contexts.set(id, { id, context: new WeakRef(gl), canvas: new WeakRef(this),
          draws: 0, clearPasses: 0, renderedFrames: 0, lastFrame: -1, outsideRafClearPasses: 0,
          renderer: String(gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)) });
        for (const event of ['webglcontextlost', 'webglcontextrestored']) {
          this.addEventListener(event, () => contextEvents.push({ id, event, time: performance.now() }));
        }
      }
      return context;
    },
  });
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    for (const method of ['clear', 'drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = Reflect.get(prototype, method) as unknown;
      if (typeof original !== 'function') continue;
      Object.defineProperty(prototype, method, {
        configurable: true, writable: true,
        value: function (this: WebGLRenderingContext, ...args: unknown[]) {
          const id = contextIds.get(this);
          const record = id === undefined ? undefined : contexts.get(id);
          if (record) {
            if (method === 'clear') {
              record.clearPasses += 1;
              if (!inFrame) record.outsideRafClearPasses += 1;
            } else {
              record.draws += 1;
              if (inFrame && record.lastFrame !== frame) {
                record.renderedFrames += 1;
                record.lastFrame = frame;
              }
            }
          }
          return Reflect.apply(original, this, args);
        },
      });
    }
  }
  const snapshot = () => {
    const elapsedMs = performance.now() - start;
    return {
      elapsedMs, visibility: document.visibilityState,
      liveRafCallbacks: [...callbacks.values()].filter(record => record.pending > 0).length,
      pendingRafRequests: pending.size,
      callbacks: [...callbacks].filter(([, record]) => record.calls || record.pending).map(([id, record]) => ({ id, ...record })),
      longTasksSupported, longTasks, longTaskMs, longestTaskMs,
      contextEvents: [...contextEvents],
      contexts: [...contexts.values()].map(record => {
        const gl = record.context.deref();
        const canvas = record.canvas.deref();
        const box = canvas?.getBoundingClientRect();
        return {
          id: record.id, renderer: record.renderer, reachable: !!gl,
          lost: gl?.isContextLost() ?? null, connected: canvas?.isConnected ?? false,
          hook: canvas?.getAttribute('data-builder-hook') ?? canvas?.getAttribute('data-placement-hook') ?? canvas?.id ?? null,
          layoutVisible: !!box && box.width > 0 && box.height > 0 && getComputedStyle(canvas!).visibility !== 'hidden',
          inViewport: !!box && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
          renderedFrames: record.renderedFrames, renderedRafFramesPerSecond: record.renderedFrames * 1000 / elapsedMs,
          clearPasses: record.clearPasses, clearPassesPerSecond: record.clearPasses * 1000 / elapsedMs,
          outsideRafClearPasses: record.outsideRafClearPasses, drawCalls: record.draws,
        };
      }),
    };
  };
  window.__logoRenderingProbe = {
    snapshot,
    reset: () => {
      start = performance.now();
      longTasks = 0; longTaskMs = 0; longestTaskMs = 0;
      for (const record of callbacks.values()) record.calls = 0;
      for (const record of contexts.values()) {
        record.draws = 0; record.clearPasses = 0; record.renderedFrames = 0; record.outsideRafClearPasses = 0;
      }
    },
  };
}

declare global {
  interface Window {
    __logoRenderingProbe: {
      reset(): void;
      snapshot(): unknown;
    };
  }
}
