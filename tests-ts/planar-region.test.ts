import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPlanarMapping, fitUniformScale, type CalibrationEvidence } from "../src/core/calibration/index.js";
import { buildEvidence, snapshotEvidence } from "../src/core/calibration-session/index.js";
import { createPlanarRegion, buildRegionBundle, serializeRegionBundle, probeRegionPoint, isRegionStale,
  regionToAxesFrame, validateRegionRecord, type PlanarRegionAnchor, type PlanarRegionInput, type PlanarRegionRecord } from "../src/core/planar-region/index.js";

const input: PlanarRegionInput = {regionId:"front", frameId:"front-mm", originAnchorId:"O",xAnchorId:"X",yAnchorId:"Y",offPlaneToleranceMm:0.01};
const anchors = (): PlanarRegionAnchor[] => [
  {id:"O",model:{x:0,y:0,z:0}}, {id:"X",model:{x:10,y:0,z:0}}, {id:"Y",model:{x:3,y:5,z:0}},
];
function evidence(points=anchors(), overrides: Partial<CalibrationEvidence>={}): CalibrationEvidence {
  const built=buildEvidence({product:"synthetic-tee",variant:"M",calibrationId:"cal-1",frameId:"asset-root",provisionalVersion:"draft-1",
    assetFullSha256:"ab".repeat(32),toleranceMm:0.5,relativeTolerance:0.01},points,[{a:"O",b:"X",distanceMm:100}]);
  assert.ok(built.ok); return {...built.evidence,...overrides};
}
function create(points=anchors(), spec=input, ev=evidence(points)) {
  return createPlanarRegion(spec,points,ev,snapshotEvidence(ev));
}
function region(spec=input): PlanarRegionRecord {const made=create(anchors(),spec);assert.ok(made.ok);return made.region;}
function close(actual:number,expected:number) {assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);}

describe("planar region frame",()=>{
  it("projects the Y-side anchor and makes orthonormal axes",()=>{
    const made=create();assert.ok(made.ok);assert.deepEqual(made.region.xAxis,{x:1,y:0,z:0});
    assert.deepEqual(made.region.yAxis,{x:0,y:1,z:0});assert.deepEqual(made.region.normal,{x:0,y:0,z:1});
    assert.equal(made.region.mmPerModelUnit,10);const point=made.mapping.toPhysicalMm(anchors()[2]!.model);assert.ok(!("error" in point));close(point.point.x,30);close(point.point.y,50);
  });
  it("handles translated, rotated and scaled anchors without camera coordinates",()=>{
    const transformed=anchors().map(a=>({...a,model:{x:5-a.model.y*2,y:8+a.model.x*2,z:-3}}));
    const made=create(transformed);assert.ok(made.ok);assert.deepEqual(made.region.origin,{x:5,y:8,z:-3});
    assert.deepEqual(made.region.xAxis,{x:0,y:1,z:0});assert.deepEqual(made.region.yAxis,{x:-1,y:0,z:0});close(made.region.mmPerModelUnit,5);
    const point=made.mapping.toPhysicalMm(transformed[1]!.model);assert.ok(!("error" in point));close(point.point.x,100);close(point.point.y,0);
  });
  it("roundtrips mm and model coordinates",()=>{
    const made=create();assert.ok(made.ok);const p={x:-40,y:63};const result=made.mapping.toPhysicalMm(made.mapping.toModel(p));assert.ok(!("error" in result));close(result.point.x,p.x);close(result.point.y,p.y);
  });
  it("reverses X and normal when source direction reverses",()=>{
    const made=create(anchors(),{...input,originAnchorId:"X",xAnchorId:"O"});assert.ok(made.ok);close(made.region.xAxis.x,-1);close(made.region.normal.z,-1);
    const result=made.mapping.toPhysicalMm({x:2,y:0,z:0});assert.ok(!("error" in result));close(result.point.x,80);
  });
  it("rejects coincident, zero, collinear and nearparallel spans",()=>{
    for(const p of [{x:0,y:0,z:0},{x:5,y:0,z:0},{x:5,y:1e-7,z:0}]){const points=anchors();points[2]!.model=p;assert.equal(create(points).ok,false);}
    const points=anchors();points[1]!.model={...points[0]!.model};assert.equal(create(points).ok,false);
  });
  it("rejects overflow and nonfinite coordinates",()=>{
    const points=anchors();points[0]!.model.x=1e308;points[1]!.model.x=-1e308;assert.equal(create(points).ok,false);
    points[0]!.model.x=NaN;const valid=evidence();assert.equal(createPlanarRegion(input,points,valid,snapshotEvidence(valid)).ok,false);
  });
  it("requires distinct existing anchors, identities and explicit finite tolerance",()=>{
    for(const spec of [{...input,xAnchorId:"O"},{...input,yAnchorId:"missing"},{...input,regionId:" "},{...input,frameId:""},
      {...input,offPlaneToleranceMm:-1},{...input,offPlaneToleranceMm:NaN}])assert.equal(create(anchors(),spec).ok,false);
  });
  it("rejects inconsistent measured calibration",()=>{
    const ev=evidence(anchors(),{extraMeasurements:[{pairIds:["O","X"],distanceMm:1000}]});assert.equal(create(anchors(),input,ev).ok,false);
  });
  it("requires source snapshot and selected coordinates to match evidence",()=>{
    const ev=evidence();assert.equal(createPlanarRegion(input,anchors(),ev,"forged snapshot").ok,false);
    const changed=anchors();changed[2]!.model.y=123;assert.equal(createPlanarRegion(input,changed,ev,snapshotEvidence(ev)).ok,false);
    const missing=evidence(anchors().slice(0,2));assert.equal(createPlanarRegion(input,anchors(),missing,snapshotEvidence(missing)).ok,false);
  });
  it("rejects probes beyond tolerance and nonfinite points",()=>{
    const r=region();assert.ok("error" in probeRegionPoint(r,{x:0,y:0,z:0.002}));assert.ok("error" in probeRegionPoint(r,{x:NaN,y:0,z:0}));
    const within=probeRegionPoint(r,{x:2,y:3,z:0.0005});assert.ok(!("error" in within));close(within.offPlaneMm,0.005);
    assert.doesNotThrow(()=>probeRegionPoint({...r,xAxis:{x:0,y:0,z:0}},{x:0,y:0,z:0}));
  });
  it("copies source data and exposes a 100mm preview span",()=>{
    const points=anchors(),ev=evidence(points);const before=JSON.stringify({points,ev});const made=create(points,input,ev);assert.ok(made.ok);assert.equal(JSON.stringify({points,ev}),before);
    made.region.origin.x=500;close(made.mapping.toModel({x:0,y:0}).x,0);close(points[0]!.model.x,0);
    const axes=regionToAxesFrame(region());assert.equal(axes.lengthMm,100);assert.equal(axes.mmPerModelUnit,10);
    axes.origin.x=300;close(region().origin.x,0);
  });
  it("validates structural records and tracks evidence changes",()=>{
    const r=region(),snap=snapshotEvidence(evidence());assert.ok(validateRegionRecord(r).ok);assert.equal(validateRegionRecord(null).ok,false);
    assert.equal(validateRegionRecord({...r,mmPerModelUnit:-1}).ok,false);assert.equal(isRegionStale(r,snap),false);assert.equal(isRegionStale(r,snapshotEvidence(evidence(anchors(),{variant:"XL"}))),true);
  });
});

describe("planar region bundle",()=>{
  it("sorts multiple region drafts and serializes deterministically",()=>{
    const ev=evidence(),fit=fitUniformScale(ev),r1=region(),r2=region({...input,regionId:"back",frameId:"back-mm",originAnchorId:"X",xAnchorId:"O"});
    const a=buildRegionBundle(ev,fit,[r1,r2],snapshotEvidence(ev));const b=buildRegionBundle(ev,fit,[r2,r1],snapshotEvidence(ev));assert.ok(a.ok&&b.ok);
    assert.equal(serializeRegionBundle(a.bundle),serializeRegionBundle(b.bundle));assert.deepEqual(a.bundle.regions.map(r=>r.regionId),["back","front"]);
    assert.equal(a.bundle.pendingReview,true);assert.equal(a.bundle.productionApproved,false);assert.equal(a.bundle.session.fit.pendingReview,true);assert.equal(a.bundle.session.fit.productionApproved,false);
  });
  it("allows zero regions while keeping calibration pending review",()=>{
    const ev=evidence();const bundle=buildRegionBundle(ev,fitUniformScale(ev),[],snapshotEvidence(ev));assert.ok(bundle.ok);assert.deepEqual(bundle.bundle.regions,[]);
  });
  it("rejects duplicate region/frame IDs and stale snapshots",()=>{
    const ev=evidence(),fit=fitUniformScale(ev),r=region();assert.equal(buildRegionBundle(ev,fit,[r,r],snapshotEvidence(ev)).ok,false);
    assert.equal(buildRegionBundle(ev,fit,[r,{...r,regionId:"other"}],snapshotEvidence(ev)).ok,false);
    assert.equal(buildRegionBundle(ev,fit,[r],"forged snapshot").ok,false);
    assert.equal(buildRegionBundle(ev,fit,[{...r,sourceEvidenceSnapshot:"old"}],snapshotEvidence(ev)).ok,false);
  });
  it("rejects forged geometry, scale, source refs and axes",()=>{
    const ev=evidence(),fit=fitUniformScale(ev),r=region();
    for(const record of [{...r,origin:{x:4,y:0,z:0}},{...r,xAxis:{x:0,y:1,z:0}},{...r,normal:{x:0,y:0,z:-1}},
      {...r,mmPerModelUnit:1000},{...r,variant:"XL"},{...r,assetFullSha256:"ff".repeat(32)},{...r,yAnchorId:"missing"}]){
      assert.equal(buildRegionBundle(ev,fit,[record],snapshotEvidence(ev)).ok,false);
    }
  });
  it("rejects inconsistent or mismatched supplied fits",()=>{
    const ev=evidence(),fit=fitUniformScale(ev),r=region();
    for(const supplied of [{...fit,scaleMmPerUnit:42},{...fit,assetFullSha256:"ff".repeat(32)},{...fit,inconsistent:true}])assert.equal(buildRegionBundle(ev,supplied,[r],snapshotEvidence(ev)).ok,false);
    const bad=evidence(anchors(),{extraMeasurements:[{pairIds:["O","X"],distanceMm:1000}]});assert.equal(buildRegionBundle(bad,fitUniformScale(bad),[],snapshotEvidence(bad)).ok,false);
  });
  it("copies records/evidence and reconstructs mapping from exported data",()=>{
    const ev=evidence(),r=region(),before=JSON.stringify({ev,r});const built=buildRegionBundle(ev,fitUniformScale(ev),[r],snapshotEvidence(ev));assert.ok(built.ok);assert.equal(JSON.stringify({ev,r}),before);
    const exported=JSON.parse(serializeRegionBundle(built.bundle));const saved=exported.regions[0];const mapping=createPlanarMapping(saved);const point=mapping.toPhysicalMm({x:10,y:0,z:0});assert.ok(!("error" in point));close(point.point.x,100);
    built.bundle.session.evidence.pairs[0]!.model.x=999;built.bundle.regions[0]!.origin.x=888;assert.equal(JSON.stringify({ev,r}),before);
  });
});
