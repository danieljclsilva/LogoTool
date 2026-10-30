import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProjectDocument } from '../src/core/types.js';
import { projectAreaToMm } from '../src/core/model-placement/area-projection.js';
import { modelAreaRegionId } from '../src/core/model-placement/index.js';
import { modelAssetKeyOf, modelSetupSidecarPathFor, spanScopeSuffix, resolveModelPlacementScene, selectValidModelSetupSidecars } from '../src/ui/model-placement-scene.js';
import { selectPresentationPackageAssets } from '../src/ui/customer-editor/presentation-assets.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture() {
  const project = JSON.parse(readFileSync(new URL('../../examples/projects/project-multi.project.json', import.meta.url), 'utf8')) as ProjectDocument;
  const product = project.products[0]!;
  const variant = product.variants[0]!;
  const modelPath = 'presentation/model.glb';
  const model = new Uint8Array(readFileSync(new URL('../../examples/models/synthetic-block.glb', import.meta.url)));
  const key = modelAssetKeyOf(modelPath, model);
  const points = [{x:-.3,y:-.3,z:.5},{x:.3,y:-.3,z:.5},{x:.3,y:.3,z:.5},{x:-.3,y:.3,z:.5}];
  const projected = projectAreaToMm(points,200)!;
  const regionId = modelAreaRegionId('chest',spanScopeSuffix(variant.id));
  const region = {...product.regions[0]!,id:regionId,safeArea:projected.ring.map(p=>[p.x,p.y] as [number,number]),calibrationRef:{calibrationId:'model-cal',version:'1'}};
  product.regions=[region];product.variants=[{...variant,regionIds:[regionId]}];
  product.calibrations=[{id:'model-cal',version:'1',description:'Synthetic test only'}];
  project.products=[product];project.configurations=[{id:'model-config',productId:product.id,variantId:variant.id,placements:[]}];
  const sidecar = {version:'setup-model-sidecar/1',kind:'model',productId:product.id,variantId:variant.id,assetKey:key,calibrationId:'model-cal',setup:{version:'0.1.0-provisional-model-setup',productId:product.id,variantId:variant.id,assetKey:key,reference:{id:'ref',a:{x:0,y:0,z:.5},b:{x:.5,y:0,z:.5},lengthMm:100},areas:[{id:'chest',name:'Chest',points,status:'current'}]}};
  const path=modelSetupSidecarPathFor(product.id,variant.id);
  const assets=new Map([['presentation/preview.json',encode({version:2,views:[],models:[{productId:product.id,variantId:variant.id,model:modelPath}]})],[modelPath,model],[path,encode(sidecar)]]);
  const scene=()=>resolveModelPlacementScene(project,assets,product.id,variant.id);
  const pool=()=>[...assets].map(([path,bytes])=>({path,bytes,kind:'additional'}));
  return {project,product,variant,assets,path,sidecar,scene,pool,modelPath};
}

test('shared model scene and issue selector retain exact calibrated mapping bytes',()=>{
  const f=fixture();const scene=f.scene()!;assert.equal(scene.regions.length,1);assert.equal(scene.regions[0]!.frame.mmPerUnit,200);
  const before=f.assets.get(f.path)!;
  const selected=selectPresentationPackageAssets(f.pool(),f.project.configurations,f.project);
  assert.equal(selected.find(a=>a.path===f.path)?.bytes,before);
  const issued=resolveModelPlacementScene(f.project,new Map(selected.map(a=>[a.path,a.bytes])),f.product.id,f.variant.id)!;
  assert.deepEqual(issued.regions,scene.regions);assert.equal(issued.bytes,scene.bytes);
  assert.deepEqual(selectValidModelSetupSidecars(f.pool(),f.project,[]),[]);
  assert.equal(selectPresentationPackageAssets(f.pool(),f.project.configurations).some(a=>a.path===f.path),false);
});

for(const scenario of ['wrong-scope','wrong-asset','stale','changed-ring','changed-calibration','unknown-version','oversized','bad-point'] as const) {
  test(`model mapping rejects ${scenario} evidence without inventing physical data`,()=>{
    const f=fixture();
    if(scenario==='wrong-scope')f.sidecar.variantId='not-issued';
    if(scenario==='wrong-asset')f.sidecar.assetKey+='changed';
    if(scenario==='stale')f.sidecar.setup.areas[0]!.status='stale';
    if(scenario==='changed-ring')f.product.regions[0]!.safeArea[0]![0]+=1;
    if(scenario==='changed-calibration')f.product.regions[0]!.calibrationRef.version='2';
    if(scenario==='unknown-version')f.sidecar.version='unknown';
    if(scenario==='bad-point')f.sidecar.setup.areas[0]!.points[0]!.x=NaN;
    f.assets.set(f.path,scenario==='oversized'?new Uint8Array(65537):encode(f.sidecar));
    assert.deepEqual(f.scene()?.regions,[]);assert.deepEqual(selectValidModelSetupSidecars(f.pool(),f.project,f.project.configurations),[]);
  });
}

test('unlinked and missing variant scope cannot acquire another model mapping',()=>{
  const f=fixture();f.product.variants[0]!.regionIds=[];
  assert.deepEqual(f.scene()?.regions,[]);assert.deepEqual(selectValidModelSetupSidecars(f.pool(),f.project,f.project.configurations),[]);
  assert.equal(resolveModelPlacementScene(f.project,f.assets,f.product.id,'other-variant'),null);
  f.assets.delete(f.modelPath);assert.equal(f.scene(),null);
});
