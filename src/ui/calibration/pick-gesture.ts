/** UI-only click recognition. Pixel distances decide gestures, never physical dimensions. */
export interface PickPointer {
  pointerId: number;
  clientX: number;
  clientY: number;
  button: number;
  isPrimary: boolean;
}
export class PickGesture {
  private start: PickPointer | null = null;
  private dragged = false;
  constructor(private readonly thresholdPx = 6) {
    if (!Number.isFinite(thresholdPx) || thresholdPx < 0) throw new Error('Invalid click threshold.');
  }
  cancel(): void { this.start = null; this.dragged = false; }
  begin(pointer: PickPointer): void {
    this.cancel();
    if (!pointer.isPrimary || pointer.button !== 0 || !Number.isFinite(pointer.pointerId) || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) return;
    this.start = {pointerId: pointer.pointerId, clientX: pointer.clientX, clientY: pointer.clientY, button: pointer.button, isPrimary: pointer.isPrimary};
  }
  move(pointer: Pick<PickPointer, 'pointerId' | 'clientX' | 'clientY'>): void {
    if (!this.start) return;
    if (pointer.pointerId !== this.start.pointerId || !Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) {this.cancel(); return;}
    if (Math.hypot(pointer.clientX - this.start.clientX, pointer.clientY - this.start.clientY) > this.thresholdPx) this.dragged = true;
  }
  finish(pointer: PickPointer): boolean {
    this.move(pointer);
    const clicked = this.start !== null && !this.dragged && pointer.isPrimary && pointer.button === 0;
    this.cancel();
    return clicked;
  }
}
