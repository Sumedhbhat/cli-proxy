import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const [html,css,js,demo,quota]=await Promise.all(['public/index.html','public/style.css','public/app.js','src/demo.js','src/quota.js'].map(p=>readFile(new URL(`../${p}`,import.meta.url),'utf8')));
const bootstrap = `
window.CLI_PROXY_BASE_URL='http://127.0.0.1:8318';
${demo.replaceAll('export ', '')}
${quota.replaceAll('export ', '')}
const snapshot={demo:true,connected:true,accounts:demoAccounts(),settings:{scheduler:true,intervalSeconds:60},routing:{strategy:'fill-first',affinity:true},refreshing:false,lastRefresh:new Date().toISOString(),refreshError:null,schedulerError:null,events:[],ranks:[]};
window.fetch=async(input,options={})=>{
  const path='/api/'+new URL(input,location.href).pathname.split('/api/').at(-1);
  const body=options.body?JSON.parse(options.body):{};
  const response=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
  if(path==='/api/state'){snapshot.ranks=rankAccounts(snapshot.accounts);return response(snapshot);}
  if(path==='/api/refresh'){snapshot.lastRefresh=new Date().toISOString();snapshot.accounts.forEach(a=>a.quota.fetchedAt=snapshot.lastRefresh);return response({ok:true});}
  if(path==='/api/settings'){snapshot.settings.scheduler=body.scheduler;return response({ok:true});}
  if(path==='/api/account'){const a=snapshot.accounts.find(a=>a.id===body.id);if(a)a.disabled=body.disabled;return response({ok:true});}
  return response({error:'This is the standalone demo. Run npm run setup in the repository to connect real accounts.'},409);
};
`;
const out=resolve(process.argv[2]||'.local/review.html');
await mkdir(resolve(out,'..'),{recursive:true});
let embeddedCSS = css;
for (const weight of [400,500,600,700]) {
  const font = await readFile(new URL(`../public/fonts/poppins-${weight}.ttf`, import.meta.url));
  embeddedCSS = embeddedCSS.replace(`./fonts/poppins-${weight}.ttf`, `data:font/ttf;base64,${font.toString('base64')}`);
}
const document=html.replace('<link rel="stylesheet" href="./style.css">',`<style>${embeddedCSS}</style>`).replace('<script type="module" src="./app.js"></script>',`<script type="module">${bootstrap}\n${js}</script>`);
await writeFile(out,document);console.log(out);
