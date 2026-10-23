import { backend } from './browser-backend.js';
'use strict';
/* Static edition: no upload API; all assets served by the same origin. */
const $ = (id)=>document.getElementById(id);
const docs = [];
let activeId = null;
let fontList = [];
let editingRanges = false;
let requestIndex = 0;
let previewTimer = null;
let toastTimer = null;
let zoom = 1;
let dragging = null;
let transition = null;
let transitionCount = 0;
let wheelAccum = 0;
let wheelAt = 0;
let wheelCooldown = 0;
let dragDepth = 0;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const imageCache = new Map();
const style = {cnFontId:'builtin',enFontId:'builtin',size:12,color:'#111111',bold:false,x:15,y:12};
const rule = {enablePrefix:true,prefix:'附件1-',enableSeq:true,start:'1',step:1,digitsMode:'auto',digits:3,enableSuffix:false,suffix:''};
const controls = ['enablePrefix','prefix','enableSeq','startNum','stepNum','digitsMode','digits','enableSuffix','suffix','fontSize','fontColor','fontBold','posX','posY'];
const escapeHtml=(x)=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function currentDoc(){return docs.find(d=>d.id===activeId)||null;}
function selected(doc){return [...doc.selected].sort((a,b)=>a-b);}
function snapshot(doc){return {selected:[...doc.selected],overrides:[...doc.overrides],posOverrides:[...doc.posOverrides].map(([p,v])=>[p,{...v}])};}
function pushHistory(doc){if(!doc)return;doc.history.push(snapshot(doc));if(doc.history.length>70)doc.history.shift();doc.redo=[];historyButtons();}
function historyButtons(){const d=currentDoc();$('undoAction').disabled=!d?.history.length;$('redoAction').disabled=!d?.redo.length;}
function historyMove(undo){const d=currentDoc();if(!d)return;const from=undo?d.history:d.redo,to=undo?d.redo:d.history;if(!from.length)return;
 to.push(snapshot(d));const state=from.pop();d.selected=new Set(state.selected);d.overrides=new Map(state.overrides);d.posOverrides=new Map(state.posOverrides);
 $('pageRanges').value=compressPages(selected(d));renderFiles();renderStrip();renderMapping();renderSelection();updatePositionControls();historyButtons();queuePreview(10);
}
function status(t){$('status').textContent=t;}
function toast(t, error=false){const e=$('toast');e.textContent=t;e.style.background=error?'#a3463f':'#2a4454';e.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.hidden=true,4500);}
function modal(title, message){$('modalTitle').textContent=title;$('modalText').textContent=message;$('modal').hidden=false;}
async function api(url,payload){
 if(url==='/api/preview'){
   const blob=await backend.preview(payload.id,payload.page,payload.item,payload.style,fontById,payload.scale);
   return new Response(blob,{status:200,headers:{'Content-Type':'image/png'}});
 }
 if(url==='/api/export'){
   const blob=await backend.export(payload.id,payload.items,payload.style,fontById);
   return new Response(blob,{status:200,headers:{'Content-Type':'application/pdf'}});
 }
 if(url==='/api/export-batch'){
   const jobs=payload.jobs.map(job=>({...job,name:docs.find(d=>d.id===job.id)?.name}));
   const blob=await backend.batch(jobs,payload.jobs[0]?.style||stylePayload(),fontById,(n,total)=>status(`正在导出 ${n} / ${total}…`));
   return new Response(blob,{status:200,headers:{'Content-Type':'application/zip'}});
 }
 if(url==='/api/close'){await backend.close(payload.ids);return new Response('{}',{status:200});}
 throw Error('不支持的操作：'+url);
}
function filenameBase(n){return (n||'文件').replace(/\.pdf$/i,'');}
function downloads(blob,name){const link=document.createElement('a');const url=URL.createObjectURL(blob);link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
function updateInputs(){
 $('enablePrefix').checked=rule.enablePrefix;$('prefix').value=rule.prefix;$('prefix').disabled=!rule.enablePrefix;
 $('enableSeq').checked=rule.enableSeq;$('startNum').value=rule.start;$('stepNum').value=rule.step;
 $('digitsMode').value=rule.digitsMode;$('digits').value=rule.digits;$('digits').disabled=rule.digitsMode!=='custom';
 $('sequenceConfig').classList.toggle('hidden',!rule.enableSeq);
 $('enableSuffix').checked=rule.enableSuffix;$('suffix').value=rule.suffix;$('suffix').disabled=!rule.enableSuffix;
 updateFontSearches();
 $('fontSize').value=style.size;$('fontColor').value=style.color;$('fontBold').checked=style.bold;
 $('posX').value=style.x;$('posY').value=style.y;
 updateFontWeightNote();updateRulePreview();
}
function fetchControls(){
 rule.enablePrefix=$('enablePrefix').checked;rule.prefix=$('prefix').value;
 rule.enableSeq=$('enableSeq').checked;rule.start=$('startNum').value;
 rule.step=Math.max(1,Math.min(10000,Number($('stepNum').value)||1));
 rule.digitsMode=$('digitsMode').value;rule.digits=Math.max(1,Math.min(12,Number($('digits').value)||1));
 rule.enableSuffix=$('enableSuffix').checked;rule.suffix=$('suffix').value;
 style.size=Number($('fontSize').value)||12;style.color=$('fontColor').value;
 style.bold=$('fontBold').checked;
 if(!currentDoc()?.posOverrides.has(currentDoc()?.current)){
   style.x=Math.max(0,Number($('posX').value)||0);style.y=Math.max(0,Number($('posY').value)||0);
 }
 $('sequenceConfig').classList.toggle('hidden',!rule.enableSeq);
 $('prefix').disabled=!rule.enablePrefix;$('suffix').disabled=!rule.enableSuffix;
 $('digits').disabled=rule.digitsMode!=='custom';
 updateFontWeightNote();updateRulePreview();renderMapping();updatePositionControls();queuePreview();
}
function renderLabel(index){let seq='';if(rule.enableSeq){let start=Number(rule.start);if(!Number.isFinite(start))start=1;
 const n=Math.trunc(start)+(index*rule.step);const digits=rule.digitsMode==='custom'?rule.digits:Math.max(1,String(rule.start).length);
 seq=n>=0?String(n).padStart(digits,'0'):'-'+String(Math.abs(n)).padStart(digits,'0');}
 return (rule.enablePrefix?rule.prefix:'')+seq+(rule.enableSuffix?rule.suffix:'');
}
function updateRulePreview(){const ex=renderLabel(0);$('rulePreview').textContent=ex||'（空）';}
function displayedText(doc,page){if(!doc.selected.has(page))return '';if(doc.overrides.has(page))return doc.overrides.get(page);
 return renderLabel(selected(doc).indexOf(page));}
function makeItem(doc,page){if(!doc.selected.has(page))return null;
 const o=doc.posOverrides.get(page)||{};
 return {page,text:displayedText(doc,page),x:o.x??style.x,y:o.y??style.y};}
function allItems(doc){return selected(doc).map(p=>makeItem(doc,p));}
function stylePayload(){return {cnFontId:style.cnFontId,enFontId:style.enFontId,size:style.size,color:style.color,bold:style.bold};}
function renderFiles(){const wrap=$('fileList');if(!docs.length){wrap.innerHTML='<div class="empty-mini">尚未导入 PDF</div>';return;}
 wrap.innerHTML=docs.map(d=>`<div class="file-item ${d.id===activeId?'active':''}" data-open="${d.id}"><span class="file-symbol">PDF</span><div class="file-text"><strong title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</strong><small>${d.pageCount} 页 · 已选 ${d.selected.size} 页</small></div><button title="移除文件" class="file-remove" data-remove="${d.id}">×</button></div>`).join('');
 wrap.querySelectorAll('[data-open]').forEach(e=>e.addEventListener('click',()=>activate(e.dataset.open)));
 wrap.querySelectorAll('[data-remove]').forEach(e=>e.addEventListener('click',(ev)=>{ev.stopPropagation();removeDoc(e.dataset.remove);}));}
function releaseDocs(ids){api('/api/close',{ids}).catch(()=>{});}
function removeDoc(id){releaseDocs([id]);const ix=docs.findIndex(d=>d.id===id);if(ix<0)return;docs.splice(ix,1);for(const [k,v] of imageCache){if(k.startsWith(id+':')){URL.revokeObjectURL(v);imageCache.delete(k);}}
 if(activeId===id)activeId=docs[0]?.id||null;renderFiles();refresh();}
function activate(id){stopTransition();activeId=id;renderFiles();refresh();}
function refresh(){stopTransition();const doc=currentDoc();$('startScreen').hidden=!!doc;$('paperHolder').hidden=!doc;
 $('activeName').textContent=doc?doc.name:'尚未选择 PDF';$('docMeta').textContent=doc?`${doc.pageCount} 页 · ${doc.pages[0].widthMm} × ${doc.pages[0].heightMm} mm${doc.sameSize?'':' · 页面尺寸不统一'}`:'导入文件后开始编号';
 $('pageTotal').textContent=doc?.pageCount||'—';$('jumpPage').value=doc?.current||1;
 $('prevPage').disabled=!doc||doc.current<=1;$('nextPage').disabled=!doc||doc.current>=doc.pageCount;
 $('btnExport').disabled=!doc;$('btnExportBottom').disabled=!doc;$('exportBatch').disabled=!docs.length;
 $('currentChecked').disabled=!doc;$('localPosition').disabled=!doc;$('selectAll').disabled=!doc;$('selectNone').disabled=!doc;
 $('pageRanges').disabled=!doc;$('pageRanges').value=doc?compressPages(selected(doc)):'';
 updatePositionControls();renderStrip();renderMapping();renderSelection();historyButtons();if(doc)queuePreview(10);
}
function compressPages(sorted){const ranges=[];let i=0;while(i<sorted.length){const a=sorted[i];let b=a;while(i+1<sorted.length&&sorted[i+1]===b+1){i++;b++;}ranges.push(a===b?String(a):`${a}-${b}`);i++;}return ranges.join(', ');}
function parseRanges(value,max){if(!value.trim())return [];
 const chunks=value.replace(/[，；;]/g,',').split(',').map(s=>s.trim());
 if(chunks.some(s=>!s))throw Error('请使用例如 1-3, 5, 7-8 的格式');
 const set=new Set();for(const chunk of chunks){const m=/^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(chunk);if(!m)throw Error(`无法识别：${chunk}`);
 let a=Number(m[1]),b=m[2]?Number(m[2]):a;if(a<1||b>max||a>b)throw Error(`页码必须在 1–${max}，且范围从小到大`);
 for(let k=a;k<=b;k++)set.add(k);}
 return [...set].sort((a,b)=>a-b);}
function applySelection(doc,pages){const next=new Set(pages);
 if(doc.selected.size===next.size&&[...next].every(x=>doc.selected.has(x)))return;
 pushHistory(doc);for(const k of [...doc.overrides.keys()])if(!next.has(k))doc.overrides.delete(k);
 for(const k of [...doc.posOverrides.keys()])if(!next.has(k))doc.posOverrides.delete(k);
 doc.selected=next;
 $('selectedCount').textContent=next.size+' 页';
 renderFiles();renderStrip();renderMapping();renderSelection();queuePreview();}
function toggleCurrent(checked){const d=currentDoc();if(!d)return;const pages=new Set(d.selected);if(checked)pages.add(d.current);else pages.delete(d.current);
 applySelection(d,[...pages]);$('pageRanges').value=compressPages(selected(d));$('rangeError').hidden=true;}
function renderSelection(){const d=currentDoc();$('currentChecked').checked=!!d&&d.selected.has(d.current);
 $('selectedCount').textContent=d?d.selected.size+' 页':'0 页';$('localPosition').checked=!!d&&d.posOverrides.has(d.current);}
function updatePositionControls(){const d=currentDoc();const p=d?.posOverrides.get(d.current);
 $('localPosition').checked=!!p;$('posX').value=p?.x??style.x;$('posY').value=p?.y??style.y;
 $('resetPosition').disabled=!p;}
function renderMapping(){const d=currentDoc();const t=$('mappingRows');if(!d||!d.selected.size){t.innerHTML='<tr><td colspan="3" class="table-empty">勾选页面后显示编号</td></tr>';return;}
 t.innerHTML=selected(d).map(p=>{const text=displayedText(d,p);const manual=d.overrides.has(p);
 return `<tr><td>${p}${manual?'<span class="manual-tag">手动</span>':''}</td><td><input data-page="${p}" type="text" maxlength="180" value="${escapeHtml(text)}" aria-label="第${p}页的编号"></td><td class="reset-cell">${manual?`<button class="tiny-reset" data-reset="${p}" title="恢复自动编号">↺</button>`:''}</td></tr>`;
 }).join('');
 t.querySelectorAll('[data-page]').forEach(input=>input.addEventListener('input',()=>{
  const p=Number(input.dataset.page), index=selected(d).indexOf(p);
  if(input.dataset.edited!=='yes'){pushHistory(d);input.dataset.edited='yes';}
  if(input.value===renderLabel(index))d.overrides.delete(p);else d.overrides.set(p,input.value);
  if(p===d.current)queuePreview();
 }));
 t.querySelectorAll('[data-page]').forEach(input=>input.addEventListener('change',()=>renderMapping()));
 t.querySelectorAll('[data-reset]').forEach(button=>button.addEventListener('click',()=>{pushHistory(d);d.overrides.delete(Number(button.dataset.reset));renderMapping();queuePreview();}));
}
function stopTransition(){
 $('previewScroll').classList.remove('is-turning');
 if(!transition)return;
 clearTimeout(transition.timeout);
 $('paper').classList.remove('enter-next');
 $('transitionGhostHost').replaceChildren();
 transition=null;
}
function pendingTransition(oldDoc,page){
 stopTransition();
 const source=$('pdfImage');
 if(!oldDoc || source.naturalWidth===0 || !source.src)return null;
 // Freeze scrollbars/scroll overflow before the outgoing ghost enters the DOM.
 $('previewScroll').classList.add('is-turning');
 const ghost=document.createElement('div');
 ghost.className='page-transition-ghost';
 const oldPaper=$('paper');
 ghost.style.width=oldPaper.getBoundingClientRect().width+'px';
 ghost.style.height=oldPaper.getBoundingClientRect().height+'px';
 const img=document.createElement('img');img.src=source.currentSrc||source.src;img.draggable=false;
 ghost.append(img);$('transitionGhostHost').replaceChildren(ghost);
 transition={id:oldDoc.id,page,dir:page>oldDoc.current?'next':'prev',ghost,token:++transitionCount,timeout:null};
 return transition;
}
function beginPageMotion(page){
 if(!transition||transition.page!==page)return;
 const t=transition;
 if(!$('enablePageMotion').checked||reduceMotion.matches){stopTransition();return;}
 // Before animation begins, incoming paper and outgoing ghost share one exact centre.
 // In the settled state ONLY the incoming paper remains, with no offset/scale.
 if(t.dir==='next')$('paper').classList.add('enter-next');
 else t.ghost.classList.add('exit-prev');
 t.timeout=setTimeout(()=>{if(transition?.token===t.token)stopTransition();},520);
}
function setCurrentPage(p,animate=false){
 const d=currentDoc();if(!d)return;
 const next=Math.max(1,Math.min(d.pageCount,Math.trunc(p)));
 if(next===d.current)return;
 if(animate && !reduceMotion.matches)pendingTransition(d,next);else stopTransition();
 d.current=next;requestIndex++;$('jumpPage').value=d.current;
 $('prevPage').disabled=d.current<=1;$('nextPage').disabled=d.current>=d.pageCount;
 renderStrip();renderSelection();updatePositionControls();queuePreview(8);
}

function renderStrip(){const d=currentDoc(), strip=$('pageStrip');if(!d){strip.innerHTML='';return;}
 const n=d.pageCount,current=d.current;let visible=[];
 if(n<=30)visible=Array.from({length:n},(_,i)=>i+1);
 else{const numbers=new Set([1,2,n-1,n]);for(let i=Math.max(1,current-5);i<=Math.min(n,current+5);i++)numbers.add(i);visible=[...numbers].sort((a,b)=>a-b);}
 let last=0;strip.innerHTML=visible.map(p=>{const dots=p>last+1?'<span class="ellipsis">…</span>':'';last=p;
 return dots+`<button class="pagechip ${d.selected.has(p)?'selected':''} ${p===current?'current':''}" data-jump="${p}">${d.selected.has(p)?'✓ ':''}${p}</button>`;}).join('');
 strip.querySelectorAll('[data-jump]').forEach(b=>b.addEventListener('click',()=>setCurrentPage(Number(b.dataset.jump))));
 strip.querySelector(`[data-jump="${current}"]`)?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function paperWidth(doc){const p=doc.pages[doc.current-1];const aspect=p.widthPt/p.heightPt;
 // Maintain same apparent size for A4, landscape and page-specific dimensions.
 return Math.min(1080,Math.max(250,Math.round(590*zoom*Math.min(1.35,aspect/.707))));}
function applyPaperDimensions(){const d=currentDoc();if(!d)return;const pw=paperWidth(d);
 $('paper').style.width=pw+'px';$('zoomText').textContent=Math.round(zoom*100)+'%';}
function isWesternChar(char){
 return /^[\x00-\x7F]$/.test(char) || /^[\u00C0-\u024F]$/.test(char) || /[–—‐‑‘’“”•·…€£¥]/.test(char);
}
function displayFontName(f){
 if(!f)return '思源宋体（内置）';
 if(/^simsun$/i.test(f.name))return '宋体 (SimSun)';
 if(/^nsimsun$/i.test(f.name))return '新宋体 (NSimSun)';
 return f.name;
}
function fontCssName(kind){
 const f=fontById(style[kind+'FontId']);
 const faceKey=(!f||f.builtin)?(style.bold?'builtin:bold':'builtin:regular'):(style.bold&&f.boldId?f.boldId:f.id);
 return JSON.stringify('PLS_'+faceKey.replace(/[^a-zA-Z0-9_]/g,'_'))+',serif';
}
function updateOverlay(){const d=currentDoc();if(!d)return;const item=makeItem(d,d.current), layer=$('labelOverlay');
 if(!item||!item.text){layer.hidden=true;return;}layer.hidden=false;
 const info=d.pages[d.current-1];layer.style.left=(item.x/info.widthMm*100)+'%';layer.style.top=(item.y/info.heightMm*100)+'%';
 const sizePt=Math.min(90,Math.max(4,style.size));const screenScale=$('paper').clientWidth/info.widthPt;
 layer.style.fontSize=(sizePt*screenScale)+'px';layer.style.minHeight=Math.max(16,sizePt*screenScale*1.4)+'px';
 layer.style.fontWeight='normal';
 const span=$('overlayText');span.replaceChildren();
 let segment='',kind=null;
 const append=()=>{if(!segment)return;const text=document.createElement('span');text.style.fontFamily=fontCssName(kind);text.style.fontWeight='400';text.style.fontSynthesis='none';text.textContent=segment;span.append(text);segment='';};
 for(const char of item.text){const k=isWesternChar(char)?'en':'cn';if(kind!==k){append();kind=k;}segment+=char;}
 append();layer.style.maxWidth=`${Math.max(0,100-item.x/info.widthMm*100)}%`;
}

async function renderBase(doc,page){const key=doc.id+':'+page;let url=imageCache.get(key);if(url)return url;
 const payload={id:doc.id,page,style:stylePayload(),scale:1.55,item:null};const resp=await api('/api/preview',payload);
 const blob=await resp.blob();url=URL.createObjectURL(blob);imageCache.set(key,url);
 if(imageCache.size>32){const first=imageCache.keys().next().value;URL.revokeObjectURL(imageCache.get(first));imageCache.delete(first);}
 return url;
}
function queuePreview(ms=260){clearTimeout(previewTimer);previewTimer=setTimeout(()=>refreshPreview(),ms);updateOverlay();}
async function commitPreviewImage(url, page, stamp){
 const d=currentDoc();if(!d||d.current!==page)return;
 const image=$('pdfImage');
 // Decode before changing image src: prevents flashes and transparent transition frames.
 const trial=new Image();trial.src=url;
 try{await trial.decode();}catch{if(!trial.complete)throw new Error('PDF 页面图片未能解码');}
 if(d!==currentDoc()||d.current!==page)return;
 const old=image.dataset.stamped;
 image.src=url;
 if(stamp)image.dataset.stamped=url;else delete image.dataset.stamped;
 if(old&&old!==url)setTimeout(()=>URL.revokeObjectURL(old),1100);
 updateOverlay();
 beginPageMotion(page);
 const p=page;
 for(const neighbor of [p-1,p+1]){
  if(neighbor>=1&&neighbor<=d.pageCount){renderBase(d,neighbor).catch(()=>{});}
 }
}
async function refreshPreview(){const d=currentDoc();if(!d)return;const request=++requestIndex;
 const page=d.current;applyPaperDimensions();updateOverlay();status(`正在渲染第 ${page} 页…`);
 try{
  const baseUrl=await renderBase(d,page);if(request!==requestIndex)return;
  const item=makeItem(d,page);
  if(!item||!item.text){
   await commitPreviewImage(baseUrl,page,false);
   if(request!==requestIndex)return;
   $('labelOverlay').hidden=true;status(`第 ${page} 页 · 不添加编号`);return;
  }
  const resp=await api('/api/preview',{id:d.id,page,style:stylePayload(),scale:1.55,item});
  const blob=await resp.blob();if(request!==requestIndex)return;
  const url=URL.createObjectURL(blob);
  await commitPreviewImage(url,page,true);
  if(request!==requestIndex)return;
  $('labelOverlay').hidden=false;
  $('labelOverlay').classList.remove('dragging');
  status(`第 ${page} 页 · ${item.text} · 已按 PDF 实际字体渲染`);
 }catch(e){if(request!==requestIndex)return;
  stopTransition();
  const base=imageCache.get(d.id+':'+page);if(base)$('pdfImage').src=base;
  updateOverlay();status('预览异常：'+e.message);toast(e.message,true);
 }
}

function setPos(d,p,x,y){x=Number(Math.max(0,x).toFixed(2));y=Number(Math.max(0,y).toFixed(2));
 if(d.posOverrides.has(p)){d.posOverrides.set(p,{x,y});}else{style.x=x;style.y=y;}
 updatePositionControls();updateOverlay();}
function dragStart(e){const d=currentDoc();if(!d||!d.selected.has(d.current))return;
 e.preventDefault();const paper=$('paper'),img=$('pdfImage');const key=d.id+':'+d.current;
 const base=imageCache.get(key);if(base)img.src=base;
 pushHistory(d);const item=makeItem(d,d.current);dragging={id:d.id,page:d.current,startX:e.clientX,startY:e.clientY,x:item.x,y:item.y};
 const overlay=$('labelOverlay');overlay.classList.add('dragging');overlay.setPointerCapture(e.pointerId);
}
function dragMove(e){if(!dragging)return;const d=currentDoc();if(!d||dragging.id!==d.id)return;
 const w=$('paper').getBoundingClientRect().width,info=d.pages[d.current-1];
 const x=dragging.x+(e.clientX-dragging.startX)*info.widthMm/w;
 const y=dragging.y+(e.clientY-dragging.startY)*info.widthMm/w;
 setPos(d,d.current,x,y);
}
function dragEnd(){if(!dragging)return;dragging=null;$('labelOverlay').classList.remove('dragging');queuePreview(40);}
async function openFiles(files){
 if(!files?.length)return;
 for(const f of files){
   if(!/\.pdf$/i.test(f.name)){toast('只支持 PDF 文件',true);continue;}
   status('解析：'+f.name);
   try{
     const info=await backend.open(f);
     info.name=f.name;info.selected=new Set();info.overrides=new Map();info.posOverrides=new Map();info.history=[];info.redo=[];info.current=1;
     docs.push(info);activeId=info.id;
     if(!info.sameSize){const unique=[...new Set(info.pages.map(p=>`${p.widthMm} × ${p.heightMm} mm`))];
       modal('检测到不同页面尺寸',`《${info.name}》包含 ${unique.length} 种可见页面尺寸：\n${unique.slice(0,7).join('\n')}\n\n请在 Acrobat 中规范化页面。静态版不会擅自缩放或裁剪。`);
     }
   }catch(e){toast(`${f.name}：${e.message}`,true);status('导入失败：'+e.message);}
 }
 renderFiles();refresh();status('导入完成 · PDF 仅存于当前浏览器内存');
}
function fontById(id){return fontList.find(f=>f.id===id)||fontList.find(f=>f.id==='builtin');}
function updateFontWeightNote(){
 const note=$('fontWeightInfo');if(!note)return;
 if(!style.bold){note.hidden=true;note.textContent='';return;}
 const missing=[];
 for(const [kind,label] of [['cn','中文'],['en','西文']]){
  const f=fontById(style[kind+'FontId']);
  if(f && !f.boldAvailable)missing.push(`${label}「${displayFontName(f)}」`);
 }
 if(missing.length){note.hidden=false;note.textContent=`${missing.join('、')}没有可用的独立粗体字重，这部分文字保持原样（不描边、不自动替换字体）。若需要真实粗体，可改选内置思源宋体等带 Bold 字重的字体。`;}
 else{note.hidden=false;note.textContent='已找到所选字体的真实 Bold 字重。PDF 使用独立粗体字形，不再模拟描边。';}
}

function updateFontSearches(){
 for(const kind of ['cn','en']){
  const input=$(kind+'FontSearch'),chosen=fontById(style[kind+'FontId']);
  input.value=displayFontName(chosen);input.title=input.value;
 }
}
function fontSearchResults(kind,typed=''){
 const dest=$(kind+'FontResults'),query=typed.trim().toLocaleLowerCase();
 const matches=fontList.filter(f=>(displayFontName(f)+' '+f.name).toLocaleLowerCase().includes(query)).slice(0,80);
 dest.replaceChildren();
 if(!matches.length){dest.innerHTML='<div class="empty-mini">没有匹配字体</div>';dest.hidden=false;return;}
 for(const f of matches){const b=document.createElement('button');b.type='button';b.className='font-option';
  b.textContent=displayFontName(f);
  if(f.builtin){const note=document.createElement('small');note.textContent='内置';b.append(note);}
  b.addEventListener('mousedown',e=>e.preventDefault());
  b.addEventListener('click',()=>chooseFont(kind,f.id));dest.append(b);
 }
 dest.hidden=false;
}
function chooseFont(kind,id){
 style[kind+'FontId']=id;
 $(kind+'FontResults').hidden=true;
 updateFontSearches();updateFontWeightNote();queuePreview(30);
}
function bindFontPickers(){
 for(const kind of ['cn','en']){
  const input=$(kind+'FontSearch');const menu=$(kind+'FontResults');
  input.addEventListener('focus',()=>fontSearchResults(kind,''));
  input.addEventListener('dblclick',()=>{input.select();fontSearchResults(kind,'');});
  input.addEventListener('input',()=>fontSearchResults(kind,input.value));
  input.addEventListener('keydown',e=>{
   if(e.key==='Escape'){menu.hidden=true;input.value=displayFontName(fontById(style[kind+'FontId']));input.blur();}
   if(e.key==='ArrowDown'&&menu.querySelector('button')){e.preventDefault();menu.querySelector('button').focus();}
   if(e.key==='Enter'){
    e.preventDefault();const f=fontList.find(f=>displayFontName(f).toLocaleLowerCase()===input.value.trim().toLocaleLowerCase()||f.name.toLocaleLowerCase()===input.value.trim().toLocaleLowerCase());
    if(f)chooseFont(kind,f.id);else if(menu.querySelector('button'))menu.querySelector('button').click();else input.value=displayFontName(fontById(style[kind+'FontId']));
   }
  });
  input.addEventListener('blur',()=>setTimeout(()=>{if(!menu.contains(document.activeElement)){menu.hidden=true;updateFontSearches();}},130));
  menu.addEventListener('keydown',e=>{
   const buttons=[...menu.querySelectorAll('button')],at=buttons.indexOf(document.activeElement);
   if(e.key==='ArrowDown'){e.preventDefault();buttons[Math.min(buttons.length-1,at+1)]?.focus();}
   if(e.key==='ArrowUp'){e.preventDefault();if(at<=0)input.focus();else buttons[at-1]?.focus();}
   if(e.key==='Escape'){menu.hidden=true;input.focus();}
  });
 }
 document.addEventListener('pointerdown',e=>{
  for(const kind of ['cn','en'])if(!$(kind+'FontSearch').parentElement.contains(e.target))$(kind+'FontResults').hidden=true;
 });
}
async function initFonts(){
 fontList=[{id:'builtin',name:'思源宋体（内置常用字）',builtin:true,boldAvailable:true}];
 style.cnFontId='builtin';style.enFontId='builtin';
 const button=$('scanFonts');
 button.addEventListener('click',async()=>{
   if(typeof window.queryLocalFonts!=='function'){
     toast('此浏览器不支持读取已安装字体，请使用桌面版 Chrome/Edge，或手工导入字体文件。',true);return;
   }
   button.disabled=true;button.textContent='正在读取字体…';
   try{
     const faces=await window.queryLocalFonts();
     const groups=new Map();
     for(const face of faces){
       const family=face.family||face.fullName||face.postscriptName;
       if(!groups.has(family))groups.set(family,[]);
       groups.get(family).push(face);
     }
     const existing=fontList.filter(f=>f.builtin||f.file);
     const local=[];let counter=0;
     for(const [family,faceGroup] of groups){
       const regular=faceGroup.find(f=>/^regular$|^normal$|^roman$|^标准$/i.test(f.style||''))||
                     faceGroup.find(f=>!/bold|black|italic|oblique/i.test(f.style||''))||faceGroup[0];
       const bold=faceGroup.find(f=>/bold/i.test(f.style||'')&&!/italic|oblique/i.test(f.style||''));
       const id='local_'+counter++;
       const boldId=bold&&bold!==regular?'local_bold_'+counter++:null;
       const record={id,name:family,fullName:regular.fullName,postscriptName:regular.postscriptName,
         fontData:regular,boldId,boldAvailable:!!boldId,builtin:false};
       if(boldId)record.faceMap=new Map([[boldId,{id:boldId,name:family+' Bold',postscriptName:bold.postscriptName,fontData:bold}]]);
       local.push(record);
     }
     fontList=[...existing,...local].sort((a,b)=>a.builtin?-1:b.builtin?1:a.name.localeCompare(b.name,'zh-CN'));
     const simsun=local.find(f=>/^(simsun|宋体)$/i.test(f.name)||/simsun/i.test(f.postscriptName||''));
     const tnr=local.find(f=>/^times new roman$/i.test(f.name));
     style.cnFontId=simsun?.id||style.cnFontId;
     style.enFontId=tnr?.id||style.enFontId;
     $('fontInfo').textContent=`已授权读取 ${local.length} 个本机字体家族。`+
       `${simsun?'中文选用真正宋体 SimSun':'未发现宋体，中文使用当前字体'}；`+
       `${tnr?'西文选用 Times New Roman':'未发现 Times New Roman，西文使用当前字体'}。导出时会检查字体嵌入权限。`;
     updateFontSearches();updateFontWeightNote();queuePreview(60);
     toast(`已读取 ${local.length} 个字体家族`);
   }catch(e){toast('读取本机字体失败：'+e.message,true);}
   finally{button.disabled=false;button.textContent='读取已安装字体';}
 });
 for(const [kind,inputId] of [['cn','cnFontFile'],['en','enFontFile']]){
   $(inputId).addEventListener('change',e=>{
     const file=e.target.files[0];if(!file)return;
     if(file.size>50*1024*1024){toast('单个字体最大 50 MB',true);return;}
     const name=file.name.replace(/\.(ttf|otf|ttc)$/i,'');
     const id='file_'+Date.now()+'_'+kind;
     fontList.push({id,name,file,postscriptName:name,boldAvailable:/bold/i.test(name)});
     chooseFont(kind,id);e.target.value='';
     toast('已选字体 '+file.name+'；导出时验证能否嵌入。');
   });
 }
 updateFontSearches();updateFontWeightNote();
 if(typeof window.queryLocalFonts!=='function')$('fontInfo').textContent='本浏览器不能直接列出系统字体，可上传 TTF/OTF/TTC。默认使用可合法分发的内置常用字思源宋体。';
}

async function exportOne(){const d=currentDoc();if(!d){toast('请先选择 PDF',true);return;}
 const items=allItems(d);if(items.some(x=>!x.text)){toast('有勾选页的编号为空，请修改后导出',true);return;}
 status('正在生成 PDF 并嵌入字形…');$('btnExport').disabled=true;$('btnExportBottom').disabled=true;
 try{const resp=await api('/api/export',{id:d.id,items,style:stylePayload()});
 const blob=await resp.blob();downloads(blob,filenameBase(d.name)+'_已编号.pdf');toast(`已生成 ${items.length} 个编号；PDF 已保存到浏览器下载位置。`);status(`导出完成 · ${items.length} 页编号`);
 }catch(e){toast('导出失败：'+e.message,true);status('导出失败：'+e.message);}finally{$('btnExport').disabled=false;$('btnExportBottom').disabled=false;}
}
async function exportBatch(){if(!docs.length)return;
 const jobs=docs.map(d=>({id:d.id,items:allItems(d),style:stylePayload()}));
 if(jobs.some(j=>j.items.some(x=>!x.text))){toast('存在空编号，请检查映射表',true);return;}
 status('批量导出并压缩中…');$('exportBatch').disabled=true;
 try{const resp=await api('/api/export-batch',{jobs});const blob=await resp.blob();downloads(blob,'PDF附件编号_批量导出.zip');toast(`已打包 ${jobs.length} 个 PDF`);status('批量导出完成');}
 catch(e){toast('批量导出失败：'+e.message,true);status('批量导出失败');}
 finally{$('exportBatch').disabled=false;}
}
function saveTemplate(){
 const data={version:2,kind:'PDFLabelStudioStyleTemplate',
  style:{...style,cnFontName:fontById(style.cnFontId)?.name||'思源宋体（内置）',enFontName:fontById(style.enFontId)?.name||'思源宋体（内置）'},
  rule:$('saveRule').checked?{...rule}:null};
 downloads(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),'PDF_Label_Style.json');
 toast('已保存样式模板（不包含 PDF、页码或编号映射）');
}
async function loadTemplate(file){try{
 const content=JSON.parse(await file.text());if(content.kind!=='PDFLabelStudioStyleTemplate')throw Error('不是 PDF Label Studio 模板');
 const st=content.style||{};
 for(const key of ['size','color','bold','x','y'])if(st[key]!==undefined)style[key]=st[key];
 const findName=(name)=>fontList.find(f=>f.name===name);
 const cnName=st.cnFontName||st.fontName;
 const enName=st.enFontName;
 if(cnName){const font=findName(cnName);style.cnFontId=font?.id||'builtin';if(!font)toast(`本机没有模板中文字体「${cnName}」，已使用内置字体`,true);}
 if(enName){const font=findName(enName);style.enFontId=font?.id||'builtin';if(!font)toast(`本机没有模板西文字体「${enName}」，已使用内置字体`,true);}
 // v1 template has only a single font; keep an independent Western default.
 if(content.rule)for(const key of Object.keys(rule))if(content.rule[key]!==undefined)rule[key]=content.rule[key];
 updateInputs();renderMapping();updatePositionControls();queuePreview();toast('已载入模板');
 }catch(e){toast('模板加载失败：'+e.message,true);}}

function bindFileDrop(){
 const cover=$('dropCover');
 const hasFiles=e=>[...e.dataTransfer?.types||[]].includes('Files');
 window.addEventListener('dragenter',e=>{if(!hasFiles(e))return;e.preventDefault();dragDepth++;cover.hidden=false;});
 window.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';cover.hidden=false;});
 window.addEventListener('dragleave',e=>{if(!hasFiles(e))return;e.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)cover.hidden=true;});
 window.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;cover.hidden=true;
  const files=[...(e.dataTransfer?.files||[])];if(files.length)openFiles(files);
 });
}
function changeZoom(step){
 zoom=Math.min(1.7,Math.max(.5,Math.round((zoom+step)*10)/10));
 applyPaperDimensions();updateOverlay();
}
function bindPageWheel(){
 const el=$('previewScroll');
 el.addEventListener('wheel',e=>{
  const d=currentDoc();if(!d)return;
  if(e.ctrlKey||e.metaKey){e.preventDefault();changeZoom(e.deltaY>0?-.1:.1);return;}
  if(dragging)return;
  // Let the native scroll move within a zoomed-in page. At the ends, turn pages.
  const max=el.scrollHeight-el.clientHeight;
  if(zoom>1.001&&max>3){
   const atBottom=el.scrollTop>=max-3;
   const atTop=el.scrollTop<=3;
   if((e.deltaY>0&&!atBottom)||(e.deltaY<0&&!atTop)){
    wheelAccum=0;return;
   }
  }
  e.preventDefault();
  if(e.deltaY===0)return;
  let dy=e.deltaY;
  if(e.deltaMode===1)dy*=18;else if(e.deltaMode===2)dy*=el.clientHeight;
  const now=performance.now();
  if(now-wheelAt>260||Math.sign(wheelAccum)!==Math.sign(dy))wheelAccum=0;
  wheelAt=now;wheelAccum+=dy;
  // Wheel delta varies hugely between mice and touchpads; only one navigation per gesture.
  if(Math.abs(wheelAccum)<55||now<wheelCooldown)return;
  const dir=Math.sign(wheelAccum);wheelAccum=0;wheelCooldown=now+510;
  setCurrentPage(d.current+dir,true);
 },{passive:false});
}
function bindEvents(){
 $('btnOpen').onclick=()=>$('fileInput').click();$('emptyOpen').onclick=()=>$('fileInput').click();
 $('fileInput').onchange=(e)=>{openFiles([...e.target.files]);e.target.value='';};
 $('clearFiles').onclick=()=>{releaseDocs(docs.map(d=>d.id));for(const url of imageCache.values())URL.revokeObjectURL(url);imageCache.clear();docs.length=0;activeId=null;renderFiles();refresh();};
 $('btnExport').onclick=exportOne;$('btnExportBottom').onclick=exportOne;$('exportBatch').onclick=exportBatch;
 for(const id of controls){$(id).addEventListener('input',()=>{
  if(id==='posX'||id==='posY'){
   const d=currentDoc();if(d?.posOverrides.has(d.current)){
     const p=d.posOverrides.get(d.current);p.x=Math.max(0,Number($('posX').value)||0);p.y=Math.max(0,Number($('posY').value)||0);
     fetchControls();queuePreview();return;
   }
  }
  fetchControls();
 });}
 $('pageRanges').addEventListener('input',e=>{const d=currentDoc();if(!d)return;try{const pages=parseRanges(e.target.value,d.pageCount);$('rangeError').hidden=true;applySelection(d,pages);}
 catch(err){$('rangeError').hidden=false;$('rangeError').textContent=err.message;}});
 $('pageRanges').addEventListener('blur',()=>{const d=currentDoc();if(d&&$('rangeError').hidden)$('pageRanges').value=compressPages(selected(d));});
 $('currentChecked').onchange=e=>toggleCurrent(e.target.checked);
 $('selectAll').onclick=()=>{const d=currentDoc();if(!d)return;applySelection(d,Array.from({length:d.pageCount},(_,i)=>i+1));$('pageRanges').value=compressPages(selected(d));};
 $('selectNone').onclick=()=>{const d=currentDoc();if(!d)return;applySelection(d,[]);$('pageRanges').value='';};
 $('resetManual').onclick=()=>{const d=currentDoc();if(!d||!d.overrides.size)return;pushHistory(d);d.overrides.clear();renderMapping();queuePreview();toast('手动编号已恢复为自动序列');};
 $('prevPage').onclick=()=>setCurrentPage(currentDoc().current-1,true);$('nextPage').onclick=()=>setCurrentPage(currentDoc().current+1,true);
 $('jumpPage').addEventListener('change',e=>{const n=Number(e.target.value);if(Number.isInteger(n))setCurrentPage(n,false);});
 $('jumpPage').addEventListener('keydown',e=>{if(e.key==='Enter')e.target.blur();});
 $('zoomIn').onclick=()=>changeZoom(.1);
 $('zoomOut').onclick=()=>changeZoom(-.1);
 $('localPosition').onchange=e=>{const d=currentDoc();if(!d)return;pushHistory(d);
 if(e.target.checked){d.posOverrides.set(d.current,{x:style.x,y:style.y});}else d.posOverrides.delete(d.current);
 updatePositionControls();queuePreview();};
 $('resetPosition').onclick=()=>{const d=currentDoc();if(d?.posOverrides.has(d.current)){pushHistory(d);d.posOverrides.delete(d.current);updatePositionControls();queuePreview();}};
 $('labelOverlay').addEventListener('pointerdown',dragStart);$('labelOverlay').addEventListener('pointermove',dragMove);$('labelOverlay').addEventListener('pointerup',dragEnd);$('labelOverlay').addEventListener('pointercancel',dragEnd);
 $('saveTemplate').onclick=saveTemplate;$('loadTemplate').onclick=()=>$('tplInput').click();
 $('tplInput').onchange=e=>{if(e.target.files[0])loadTemplate(e.target.files[0]);e.target.value='';};
 $('undoAction').onclick=()=>historyMove(true);$('redoAction').onclick=()=>historyMove(false);
 bindFontPickers();bindFileDrop();bindPageWheel();
 $('modalClose').onclick=()=>$('modal').hidden=true;
 $('modal').addEventListener('click',e=>{if(e.target===$('modal'))$('modal').hidden=true;});
 document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();historyMove(e.shiftKey?false:true);return;}
 if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();historyMove(false);return;}
 if(e.key==='ArrowLeft'&&currentDoc())setCurrentPage(currentDoc().current-1,true);
 if(e.key==='ArrowRight'&&currentDoc())setCurrentPage(currentDoc().current+1,true);
 if((e.key===' '||e.key==='Enter')&&document.activeElement===$('currentPageToggle')){e.preventDefault();toggleCurrent(!currentDoc().selected.has(currentDoc().current));}
 });
}
(async function start(){bindEvents();await initFonts();updateInputs();refresh();status('就绪 · PDF 不上传；所有内容在浏览器内处理');})();
