import { ingestValidatedAsset } from '../../assets/index.js';
import { ModelViewer } from '../../viewer/model-viewer.js';
import { AssetInspector } from './inspector.js';
const root = document.getElementById('asset-inspector');
if (!root) throw new Error('Missing inspector root.');
AssetInspector.bind({ root, ingest: ingestValidatedAsset, createViewer: (canvas, onStatus) => ModelViewer.attach({canvas}, onStatus), operator: 'prototype-operator' });
