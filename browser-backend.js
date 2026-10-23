/* PDF Label Studio: all PDF bytes are parsed, rendered and written in this browser.
 * Only same-origin static assets are fetched. No uploads or tracking. */
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import {visiblePointFromTop, dimensionsOfView} from './geometry.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const docs = new Map();
const fontCache = new Map();
const displayFontCache = new Map();
const FONT_BASE = `${import.meta.env.BASE_URL}fonts/`;
const MAX_DOC_SIZE = 100 * 1024 * 1024;
const MAX_PAGES = 2000;
const MM_PT = 72 / 25.4;

function errorText(error) { return error?.message || String(error); }
function bytesDecode(b, p, size) { return String.fromCharCode(...b.slice(p, p + size)); }
function be16(view, position) { return view.getUint16(position, false); }
function be32(view, position) { return view.getUint32(position, false); }
function put16(view, position, value) { view.setUint16(position, value, false); }
function put32(view, position, value) { view.setUint32(position, value >>> 0, false); }
function pad4(x) { return (x + 3) & ~3; }

// Chromium's FontData.blob() sometimes yields a TTC containing several faces.
// Extract the selected face into a standalone SFNT so pdf-lib can embed it.
// All tables are copied and table-directory offsets are reconstructed.
function readSfntTables(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (offset + 12 > bytes.length) throw Error('字体文件结构不完整');
  const n = be16(view, offset + 4);
  if (n < 1 || n > 200) throw Error('字体表数量异常');
  const tables = [];
  for (let i = 0; i < n; i++) {
    const q = offset + 12 + i * 16;
    if (q + 16 > bytes.length) throw Error('字体表目录不完整');
    const tag = bytesDecode(bytes, q, 4), checksum = be32(view, q + 4);
    const pos = be32(view, q + 8), length = be32(view, q + 12);
    if (length > bytes.length || pos > bytes.length - length) throw Error(`字体 ${tag} 表超出文件范围`);
    tables.push({tag, checksum, pos, length});
  }
  return {tag:bytesDecode(bytes, offset, 4), tables};
}
function nameRecordStrings(bytes, entry) {
  const table = entry.tables.find(t => t.tag === 'name');
  if (!table) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const {pos, length} = table;
  if (length < 6) return [];
  const count = be16(view, pos + 2), stringOffset = be16(view, pos + 4), arr=[];
  for (let i = 0; i < count && i < 512; i++) {
    const q=pos+6+i*12;
    if(q+12>pos+length) break;
    const platform=be16(view,q), nameId=be16(view,q+6);
    if (![1,4,6,16].includes(nameId)) continue;
    const len=be16(view,q+8), ofs=be16(view,q+10), begin=pos+stringOffset+ofs;
    if (begin+len>pos+length) continue;
    try {
      if(platform===0||platform===3) {
        let s='';for(let j=0;j+1<len;j+=2)s+=String.fromCharCode((bytes[begin+j]<<8)|bytes[begin+j+1]);
        arr.push(s.replace(/\u0000/g,''));
      } else arr.push(new TextDecoder('latin1').decode(bytes.slice(begin,begin+len)));
    } catch { /* Skip malformed optional name records. */ }
  }
  return arr;
}
function sfntChecksum(bytes, pos, length) {
  let sum=0;
  for(let i=0;i<pad4(length);i+=4) {
    const a=pos+i<bytes.length?bytes[pos+i]:0;
    const b=pos+i+1<bytes.length?bytes[pos+i+1]:0;
    const c=pos+i+2<bytes.length?bytes[pos+i+2]:0;
    const d=pos+i+3<bytes.length?bytes[pos+i+3]:0;
    sum=(sum+((a<<24)>>>0)+(b<<16)+(c<<8)+d)>>>0;
  }
  return sum;
}
function normalizeFontBytes(raw, requestedFace='') {
  const bytes = new Uint8Array(raw);
  if (bytesDecode(bytes,0,4) !== 'ttcf') return bytes;
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const count=be32(view,8);
  if(count<1||count>256||12+count*4>bytes.length)throw Error('无法读取 TTC 字体集合');
  const names=requestedFace.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
  const faces=[];
  for(let i=0;i<count;i++) {
    const entry=readSfntTables(bytes,be32(view,12+4*i));
    faces.push({...entry,names:nameRecordStrings(bytes,entry)});
  }
  const score=(entry)=>Math.max(0,...entry.names.map(s=>{
    const norm=s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g,'');
    if(!names)return 0;
    if(norm===names)return 4;
    if(norm.includes(names)||names.includes(norm))return 2;
    return 0;
  }));
  const scores=faces.map(score), index=Math.max(...scores)>0?scores.indexOf(Math.max(...scores)):-1;
  // Never silently embed a different face from the requested TTC collection.
  if(index<0 && count>1)throw Error(`TTC 字体集合中找不到「${requestedFace}」。请改用单独的 TTF/OTF 文件。`);
  const face=faces[Math.max(0,index)], tables=face.tables;
  const n=tables.length, directoryLen=12+n*16;
  let size=directoryLen;for(const table of tables)size+=pad4(table.length);
  const out=new Uint8Array(size),v=new DataView(out.buffer);
  out.set(bytes.slice(be32(view,12+4*Math.max(0,index)),be32(view,12+4*Math.max(0,index))+4),0);
  put16(v,4,n);
  const maxPower=2**Math.floor(Math.log2(n));
  put16(v,6,maxPower*16);put16(v,8,Math.log2(maxPower));put16(v,10,n*16-maxPower*16);
  let cursor=directoryLen;
  for(let i=0;i<n;i++) {
    const table=tables[i],q=12+i*16;
    for(let j=0;j<4;j++)out[q+j]=table.tag.charCodeAt(j);
    put32(v,q+4,table.checksum);put32(v,q+8,cursor);put32(v,q+12,table.length);
    out.set(bytes.slice(table.pos,table.pos+table.length),cursor);
    cursor+=pad4(table.length);
  }
  // The original shared 'head' checksumAdjustment isn't valid for standalone SFNT.
  const head=tables.findIndex(x=>x.tag==='head');
  if(head>=0) {
    const headPos=be32(v,12+head*16+8);
    if(headPos+12<out.length) {
      put32(v,headPos+8,0);
      put32(v,12+head*16+4,sfntChecksum(out,headPos,tables[head].length));
      put32(v,headPos+8,(0xB1B0AFBA-sfntChecksum(out,0,out.length))>>>0);
    }
  }
  return out;
}
function checkFontPermissions(data) {
  const b=new Uint8Array(data);
  const rec=readSfntTables(b,0);
  const os2=rec.tables.find(t=>t.tag==='OS/2');
  if(!os2 || os2.length<10)return {noSubset:false};
  const view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const flags=be16(view,os2.pos+8);
  if(flags&0x0002)throw Error('所选字体声明禁止嵌入，不能写入 PDF。请选择其他字体。');
  if(flags&0x0200)throw Error('所选字体仅允许位图嵌入，不适合写入可选中的 PDF 文字。');
  return {noSubset:!!(flags&0x0100)};
}
function isWesternChar(char) {
  return /^[\x00-\x7F]$/.test(char)||/^[\u00C0-\u024F]$/.test(char)||/[–—‐‑‘’“”•·…€£¥]/.test(char);
}
function splitRuns(str) {
  const out=[];
  for (const ch of str) {
    const kind=isWesternChar(ch)?'en':'cn';
    if (out.length && out[out.length-1].kind===kind) out[out.length-1].text+=ch;
    else out.push({kind,text:ch});
  }
  return out;
}
function resolveFace(fontRecord, bold) {
  if (!fontRecord) throw Error('尚未选择字体');
  if (fontRecord.builtin) return {key:bold?'builtin:bold':'builtin:regular',builtin:true,bold};
  if(bold && fontRecord.boldId && fontRecord.faceMap?.has(fontRecord.boldId)) {
    return { key:fontRecord.boldId,record:fontRecord.faceMap.get(fontRecord.boldId),bold:true };
  }
  return { key:fontRecord.id,record:fontRecord,bold:false };
}
async function getFontBytes(face) {
  if(fontCache.has(face.key))return fontCache.get(face.key);
  let bytes;
  if(face.builtin){
    const filename=face.bold?'PLS-CJK-Bold.otf':'PLS-CJK-Regular.otf';
    const response=await fetch(FONT_BASE+filename);
    if(!response.ok)throw Error('无法读取内置字体，请确认 GitHub Pages 已完整部署 fonts 目录');
    bytes=new Uint8Array(await response.arrayBuffer());
  } else if(face.record?.fontData) {
    const blob=await face.record.fontData.blob();
    bytes=normalizeFontBytes(await blob.arrayBuffer(),face.record.postscriptName||face.record.name);
  } else if(face.record?.file) {
    bytes=normalizeFontBytes(await face.record.file.arrayBuffer(),face.record.postscriptName||face.record.name);
  } else throw Error('当前所选字体无法提供可嵌入的数据。请重新授权本机字体或导入字体文件。');
  checkFontPermissions(bytes);
  fontCache.set(face.key,bytes);
  return bytes;
}
async function getDisplayFontFace(face) {
  if(displayFontCache.has(face.key))return displayFontCache.get(face.key);
  const bytes=await getFontBytes(face);
  const family='PLS_'+face.key.replace(/[^a-zA-Z0-9_]/g,'_');
  const ff=new FontFace(family,bytes,{style:'normal',weight:'400'});
  await ff.load();document.fonts.add(ff);
  displayFontCache.set(face.key,family);
  return family;
}
async function getPdfFonts(pdfDoc,style,fontResolver,items) {
  const result={}, created=new Map();
  const used=new Set(items.flatMap(i=>splitRuns(i.text).map(r=>r.kind)));
  for(const kind of used){
    const record=fontResolver(style[kind+'FontId']);
    const face=resolveFace(record,!!style.bold);
    if(created.has(face.key)){result[kind]=created.get(face.key);continue;}
    const bytes=await getFontBytes(face);
    try {
      const f=await pdfDoc.embedFont(bytes,{subset:false});
      created.set(face.key,f);result[kind]=f;
    } catch(e){throw Error(`${kind==='cn'?'中文':'西文'}字体「${record.name}」无法嵌入：${errorText(e)}`);}
  }
  return result;
}
function placeText(pdfPage,item,pageMeta,style,fonts) {
  const runs=splitRuns(item.text);if(!runs.length)throw Error('编号内容不能为空');
  if(/[\r\n]/.test(item.text))throw Error('编号只能使用单行文字');
  const size=Number(style.size);
  if(!(size>=4&&size<=90))throw Error('字号范围应为 4–90 pt');
  const ascent=Math.max(...runs.map(r=>fonts[r.kind].heightAtSize(size,{descender:false})));
  const descent=Math.max(...runs.map(r=>fonts[r.kind].heightAtSize(size)-fonts[r.kind].heightAtSize(size,{descender:false})),0);
  const totalWidth=runs.reduce((sum,r)=>sum+fonts[r.kind].widthOfTextAtSize(r.text,size),0);
  const {w,h}=dimensionsOfView(pageMeta.view,pageMeta.rotation);
  const x=Number(item.x)*MM_PT,y=Number(item.y)*MM_PT;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x+totalWidth>w+.1||y+ascent+descent>h+.1)
    throw Error(`第 ${item.page} 页文字超出可见页面边界，请调整坐标、字号或内容`);
  let cursor=x;
  const color=style.color.replace(/^#/,'');
  const red=parseInt(color.slice(0,2),16)/255, green=parseInt(color.slice(2,4),16)/255, blue=parseInt(color.slice(4,6),16)/255;
  for(const run of runs) {
    const p=visiblePointFromTop(pageMeta.view,pageMeta.rotation,cursor,y+ascent);
    pdfPage.drawText(run.text,{x:p.x,y:p.y,font:fonts[run.kind],size,rotate:degrees(pageMeta.rotation),color:rgb(red,green,blue)});
    cursor+=fonts[run.kind].widthOfTextAtSize(run.text,size);
  }
}

export const backend={
  async open(file) {
    if(file.size>MAX_DOC_SIZE)throw Error('单份 PDF 最大支持 100 MB');
    const bytes=await file.arrayBuffer();
    const workerBytes=new Uint8Array(bytes.slice(0));
    const task=pdfjsLib.getDocument({data:workerBytes,isEvalSupported:false,useSystemFonts:true});
    let pdf;
    try{pdf=await task.promise;}catch(e){await task.destroy();throw Error('PDF 解析失败或存在密码保护：'+errorText(e));}
    if(pdf.numPages>MAX_PAGES){await task.destroy();throw Error('超过 2000 页，请先拆分 PDF');}
    const pages=[];
    for(let p=1;p<=pdf.numPages;p++) {
      const page=await pdf.getPage(p);
      if(page.userUnit!==1){await pdf.destroy();throw Error('检测到特殊 PDF UserUnit，暂不支持精确标注；请先在 Acrobat 规范化页面');}
      const viewport=page.getViewport({scale:1});
      pages.push({widthPt:viewport.width,heightPt:viewport.height,widthMm:Number((viewport.width/MM_PT).toFixed(2)),heightMm:Number((viewport.height/MM_PT).toFixed(2)),rotation:((page.rotate%360)+360)%360,view:page.view});
      page.cleanup();
    }
    const first=pages[0],sameSize=pages.every(p=>Math.abs(p.widthPt-first.widthPt)<.2&&Math.abs(p.heightPt-first.heightPt)<.2);
    const id=crypto.randomUUID();
    docs.set(id,{bytes,pdf,loadingTask:task,pages});
    return {id,pageCount:pdf.numPages,pages,sameSize,signed:false};
  },
  async close(ids){for(const id of ids){const d=docs.get(id);if(d){docs.delete(id);await d.loadingTask.destroy();}}},
  async preview(docId,pageNumber,item,style,fontResolver,scale=1.55){
    const d=docs.get(docId);if(!d)throw Error('文件已移除');
    const page=await d.pdf.getPage(pageNumber),vp=page.getViewport({scale});
    const canvas=document.createElement('canvas');
    if(vp.width*vp.height>18000000)throw Error('该页面尺寸过大，请缩小预览');
    canvas.width=Math.max(1,Math.ceil(vp.width));canvas.height=Math.max(1,Math.ceil(vp.height));
    const ctx=canvas.getContext('2d',{alpha:false});
    ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
    try{await page.render({canvasContext:ctx,viewport:vp}).promise;}finally{page.cleanup();}
    if(item?.text){
      const runs=splitRuns(item.text);
      const faces={};
      for(const r of runs){if(!faces[r.kind]){
        const record=fontResolver(style[r.kind+'FontId']);const face=resolveFace(record,!!style.bold);
        faces[r.kind]=await getDisplayFontFace(face);
      }}
      const x=item.x*MM_PT*scale,y=item.y*MM_PT*scale,size=Number(style.size)*scale;
      let ascent=0;
      for(const r of runs){ctx.font=`${size}px "${faces[r.kind]}"`;const m=ctx.measureText(r.text);ascent=Math.max(ascent,m.actualBoundingBoxAscent||size*.88);}
      ctx.textBaseline='alphabetic';ctx.fillStyle=style.color;
      let cursor=x;
      for(const r of runs){ctx.font=`${size}px "${faces[r.kind]}"`;ctx.fillText(r.text,cursor,y+ascent);cursor+=ctx.measureText(r.text).width;}
    }
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('预览图片生成失败')),'image/png'));
    canvas.width=0;canvas.height=0;
    return blob;
  },
  async export(docId,items,style,fontResolver){
    const d=docs.get(docId);if(!d)throw Error('文件已移除');
    if(!items.length)return new Blob([d.bytes],{type:'application/pdf'});
    const pdf=await PDFDocument.load(d.bytes,{updateMetadata:false});
    pdf.registerFontkit(fontkit);
    const fonts=await getPdfFonts(pdf,style,fontResolver,items);
    const pages=pdf.getPages();
    for(const item of items){const page=pages[item.page-1],meta=d.pages[item.page-1];if(!page||!meta)throw Error(`不存在第 ${item.page} 页`);
      placeText(page,item,meta,style,fonts);
    }
    const out=await pdf.save({useObjectStreams:true,objectsPerTick:32});
    return new Blob([out],{type:'application/pdf'});
  },
  async batch(jobs,style,fontResolver,progress){
    const zip=new JSZip(),used=new Set();
    for(let i=0;i<jobs.length;i++){
      const j=jobs[i],d=docs.get(j.id);
      const n=(j.name||'文档').replace(/\.pdf$/i,'')+'_已编号.pdf';
      let name=n,k=2;while(used.has(name))name=n.replace(/\.pdf$/i,`_${k++}.pdf`);used.add(name);
      const output=await this.export(j.id,j.items,style,fontResolver);
      zip.file(name,output);progress?.(i+1,jobs.length);
    }
    return zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:5}});
  },
  normalizeFontBytes,
  clearFontCaches(){fontCache.clear();displayFontCache.clear();},
};
