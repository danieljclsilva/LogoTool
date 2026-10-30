import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import type {ProjectDocument} from '../../src/core/types.js';
import {createProjectPackage} from '../../src/packaging/project-package/index.js';
import {projectAreaToMm} from '../../src/core/model-placement/area-projection.js';
import {modelAreaRegionId} from '../../src/core/model-placement/index.js';
import {modelAssetKeyOf,modelSetupSidecarPathFor,spanScopeSuffix} from '../../src/ui/model-placement-scene.js';
import {cubeGlb} from './setup-calibration-glb.js';

/** Synthetic only: two calibrated faces, approved raster art, exact saved mapping. */
export async function customerModelPackage(artwork:Uint8Array,withMapping=true){
  const project=JSON.parse(await readFile(resolve('examples/projects/project-multi.project.json'),'utf8')) as ProjectDocument;
  project.projectId='SYN-CUSTOMER-MODEL-PROOF';project.revision=1;delete project.confirmation;delete project.history;delete project.review;delete project.reviewHistory;
  const product=project.products[0]!,variant=product.variants[0]!;
  product.name='Synthetic jacket';product.variants=[{id:variant.id,name:'Standard',regionIds:[]}];
  product.calibrations=[{id:'model-cal',version:'1',description:'Synthetic reference only'}];
  const faces=[{id:'chest',name:'Chest',points:[{x:-.4,y:-.4,z:.5},{x:.4,y:-.4,z:.5},{x:.4,y:.4,z:.5},{x:-.4,y:.4,z:.5}]},{id:'back',name:'Back',points:[{x:.4,y:-.4,z:-.5},{x:-.4,y:-.4,z:-.5},{x:-.4,y:.4,z:-.5},{x:.4,y:.4,z:-.5}]}];
  const template=product.regions[0]!;
  product.regions=faces.map(face=>({ ...template,id:modelAreaRegionId(face.id,spanScopeSuffix(variant.id)),name:face.name,frame:{...template.frame,frameId:'FRAME-'+face.id},calibrationRef:{calibrationId:'model-cal',version:'1'},safeArea:projectAreaToMm(face.points,200)!.ring.map(p=>[p.x,p.y] as [number,number]),exclusions:[],allowedMethods:['heat-seal']}));
  product.variants[0]!.regionIds=product.regions.map(r=>r.id);project.products=[product];
  const hash=createHash('sha256').update(artwork).digest('hex');
  project.logos=project.logos.slice(0,2).map((logo,i)=>({...logo,name:i===0?'Chest artwork':'Back artwork',assets:[{uri:`logos/mark-${i}.png`,role:'original',mediaType:'image/png',widthPx:100,heightPx:100,sha256Hex:hash}]}));
  project.configurations=[{id:'proof-config',productId:product.id,variantId:variant.id,placements:product.regions.map((r,i)=>({id:'placement-'+i,logoId:project.logos[i]!.id,regionId:r.id,pos:{xMm:0,yMm:0},widthMm:40,heightMm:40,rotationDeg:0,method:'heat-seal',instructions:'Prepared '+(r.name ?? 'logo area').toLowerCase()+' instruction.'}))}];
  const modelPath='presentation/jacket.glb',model=cubeGlb(false,false),assetKey=modelAssetKeyOf(modelPath,model);
  const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
  const sidecar={version:'setup-model-sidecar/1',kind:'model',productId:product.id,variantId:variant.id,assetKey,calibrationId:'model-cal',setup:{version:'0.1.0-provisional-model-setup',productId:product.id,variantId:variant.id,assetKey,reference:{id:'ref',a:{x:0,y:0,z:.5},b:{x:.5,y:0,z:.5},lengthMm:100},areas:faces.map(f=>({...f,status:'current'}))}};
  const additional=[{path:'presentation/preview.json',bytes:encode({version:2,views:[],models:[{productId:product.id,variantId:variant.id,model:modelPath}]})},{path:modelPath,bytes:model},...(withMapping?[{path:modelSetupSidecarPathFor(product.id,variant.id),bytes:encode(sidecar)}]:[])];
  const bytes=await createProjectPackage({project,assets:project.logos.map((_,i)=>({path:`logos/mark-${i}.png`,bytes:artwork})),additionalAssets:additional},{sha256:async b=>createHash('sha256').update(b).digest('hex')});
  return {bytes,project};
}
