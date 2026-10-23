import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PDFDocument, rgb} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
for(const weight of ['Regular','Bold']){
 const bytes=readFileSync(new URL(`../public/fonts/PLS-CJK-${weight}.otf`,import.meta.url));
 const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
 const font=await doc.embedFont(bytes,{subset:false});
 doc.addPage([595.28,841.89]).drawText('附件1-1（续）',{x:42,y:785,size:12,font,color:rgb(0,0,0)});
 const saved=await doc.save();
 assert.ok(saved.length>1000,weight+' PDF too small');
 assert.equal((await PDFDocument.load(saved)).getPageCount(),1);
 console.log(weight,'embedded, PDF size',saved.length,'bytes');
}
