import {existsSync,copyFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const items=[
 ['pdfjs-dist',['LICENSE','LICENSE.md','LICENSE.txt']],
 ['pdf-lib',['LICENSE.md','LICENSE','LICENSE.txt']],
 ['@pdf-lib/fontkit',['LICENSE','LICENSE.md','LICENSE.txt']],
 ['jszip',['LICENSE.markdown','LICENSE','LICENSE.md']],
 ['vite',['LICENSE.md','LICENSE','LICENSE.txt']]
];
const dest='dist/licenses';mkdirSync(dest,{recursive:true});
let copied=0;
for(const [name,candidates] of items){
 for(const filename of candidates){
  const source=join('node_modules',name,filename);
  if(existsSync(source)){copyFileSync(source,join(dest,name.replace('@','').replaceAll('/','_')+'_'+filename.replaceAll('.','_')+'.txt'));copied++;break;}
 }
}
writeFileSync(join(dest,'README.txt'),`PDF Label Studio third-party licenses copied from the versions installed during the GitHub Actions build. Copied files: ${copied}. See source README.md for package and license details.\n`);
console.log('Copied',copied,'third-party license files to dist/licenses/');
