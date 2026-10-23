/** Convert on-screen distance from visible rotated top-left to unrotated PDF user coordinates. */
export function visiblePointFromTop(view, angle, sx, sy) {
  const [x0,y0,x1,y1] = view;
  switch ((((angle % 360) + 360) % 360)) {
    case 90: return {x:x0 + sy,y:y0 + sx};
    case 180:return {x:x1 - sx,y:y0 + sy};
    case 270:return {x:x1 - sy,y:y1 - sx};
    default: return {x:x0 + sx,y:y1 - sy};
  }
}
export function dimensionsOfView(view,rotation) {
  const w=view[2]-view[0],h=view[3]-view[1];
  return rotation%180===0?{w,h}:{w:h,h:w};
}
