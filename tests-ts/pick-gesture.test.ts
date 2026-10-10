import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PickGesture } from '../src/ui/calibration/pick-gesture.js';
const pointer = (x = 0, y = 0, extra = {}) => ({pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true, ...extra});
it('accepts a primary click with small pointer movement', () => {
 const gesture = new PickGesture();gesture.begin(pointer());gesture.move(pointer(2,3));assert.equal(gesture.finish(pointer(2,3)),true);
});
it('rejects a returning orbit drag despite matching start and end positions', () => {
 const gesture = new PickGesture();gesture.begin(pointer());gesture.move(pointer(30,40));gesture.move(pointer());assert.equal(gesture.finish(pointer()),false);
});
it('rejects secondary and nonprimary pointers, and up without a matching down', () => {
 const gesture = new PickGesture();assert.equal(gesture.finish(pointer()),false);
 gesture.begin(pointer(0,0,{button:2}));assert.equal(gesture.finish(pointer(0,0,{button:2})),false);
 gesture.begin(pointer(0,0,{isPrimary:false}));assert.equal(gesture.finish(pointer()),false);
 gesture.begin(pointer());assert.equal(gesture.finish(pointer(0,0,{pointerId:2})),false);
});
it('cancellation and multitouch discard the pending click', () => {
 const gesture = new PickGesture();gesture.begin(pointer());gesture.cancel();assert.equal(gesture.finish(pointer()),false);
 gesture.begin(pointer());gesture.begin(pointer(1,1,{isPrimary:false,pointerId:2}));assert.equal(gesture.finish(pointer()),false);
});
it('invalid pointer coordinates fail closed and invalid thresholds reject', () => {
 const gesture = new PickGesture();gesture.begin(pointer());gesture.move(pointer(Number.NaN));assert.equal(gesture.finish(pointer()),false);
 assert.throws(()=>new PickGesture(Number.NaN));assert.throws(()=>new PickGesture(-1));
});
it('captures getter-backed native event properties explicitly', () => {
 const event = Object.create({get pointerId(){return 7},get clientX(){return 40},get clientY(){return 50},get button(){return 0},get isPrimary(){return true}});
 const gesture = new PickGesture();gesture.begin(event);assert.equal(gesture.finish(event),true);
});
