import { ingestValidatedAsset } from '../../assets/index.js';
import { ModelViewer } from '../../viewer/model-viewer.js';
import { CalibrationPanel } from '../calibration/panel.js';
import { AssetInspector } from './inspector.js';

const root = document.getElementById('asset-inspector');
if (!root) throw new Error('Missing inspector root.');
const calibrationRoot = document.querySelector<HTMLElement>(
  '[data-calibration-hook="panel"]',
);
if (!calibrationRoot) throw new Error('Missing calibration panel.');
let viewer: ModelViewer | null = null;
const panel = CalibrationPanel.bind({ root: calibrationRoot, viewer: () => viewer });
AssetInspector.bind({
  root,
  ingest: ingestValidatedAsset,
  createViewer: (canvas, onStatus) => {
    const attached = ModelViewer.attach({ canvas }, onStatus);
    viewer = attached.viewer;
    return attached;
  },
  operator: 'prototype-operator',
  onStateChange: (state) => {
    panel.setAsset(state.kind === 'ready' ? state.record : null);
  },
});
