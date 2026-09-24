import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import '../src/config/index.js';
const files=execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const secrets=Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(k)&&v&&v.length>=8).map(([,v])=>v!);
const violations:string[]=[];
for(const path of new Set(files)){if(path==='.env.local'||/^\.env\.(?!example$)/.test(path)){violations.push(path);continue;}if(/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(path))continue;const content=readFileSync(path,'utf8');if(secrets.some(value=>content.includes(value)))violations.push(path);}
if(violations.length){console.log(JSON.stringify({status:'failed',files:violations}));process.exitCode=1;}else console.log('Secret scan passed: no current secret values in Git-visible project files.');
