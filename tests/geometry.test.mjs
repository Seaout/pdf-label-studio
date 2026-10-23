import assert from 'node:assert/strict';
import {visiblePointFromTop, dimensionsOfView} from '../geometry.js';
const view=[20,30,615,872];
const match=(a,b)=>Math.abs(a-b)<1e-9;
const checks={
  0: [62.5,843.6,595,842],
  90:[48.4,72.5,842,595],
  180:[572.5,58.4,595,842],
  270:[586.6,829.5,842,595]
};
for(const [angle, [x,y,w,h]] of Object.entries(checks)){
 const p=visiblePointFromTop(view,Number(angle),42.5,28.4),d=dimensionsOfView(view,Number(angle));
 assert.ok(match(p.x,x)&&match(p.y,y),`${angle}° coords: ${JSON.stringify(p)}`);
 assert.ok(match(d.w,w)&&match(d.h,h),`${angle}° size: ${JSON.stringify(d)}`);
}
console.log('Geometry tests: 4 rotations including nonzero CropBox offset PASS');
