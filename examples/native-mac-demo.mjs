/** Opt-in real-model acceptance demo. Run on macOS: node examples/native-mac-demo.mjs config.json */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw new Error('Run this native acceptance demo on macOS');
const config=path.resolve(process.argv[2] ?? 'examples/config.macos.json');
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'shrimp-pi-native-demo-')));
const repo=path.join(root,'repo'), state=path.join(root,'state');fs.mkdirSync(repo);
const env={...process.env,PATH:path.dirname(process.execPath)+':/usr/bin:/bin:/usr/sbin:/sbin'};
function run(program,args,cwd=repo){const r=spawnSync(program,args,{cwd,env,encoding:'utf8',timeout:930000});if(r.status!==0)throw new Error(r.stderr||r.stdout||String(r.error));return r.stdout;}
const evidence={platform:process.platform,arch:process.arch,node:process.version,steps:[],root};
function call(...args){const value=JSON.parse(run(process.execPath,[cli,...args,'--state-dir',state]));evidence.steps.push({command:args[0],result:value});fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({command:args[0],state:value.state,outcome:value.outcome,root}));return value;}
function wait(id){for(let i=0;i<3;i++){const r=call('wait',id,'--timeout','300');if(r.state==='REVIEW_REQUIRED')return r;if(!r.timedOut)throw new Error(JSON.stringify(r));}throw new Error('demo deadline exceeded');}
fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify({name:'native-bridge-demo',type:'module',scripts:{test:'node --test'}}));
fs.writeFileSync(path.join(repo,'README.md'),'# Native bridge acceptance fixture\n');
for(const args of [['init','-q'],['config','user.name','Bridge Demo'],['config','user.email','bridge@localhost'],['add','.'],['commit','-qm','Initial fixture']])run('/usr/bin/git',args);
const task=path.join(root,'task.md');fs.writeFileSync(task,'Implement add(a,b) in index.js as a named export: require finite numeric inputs and throw TypeError otherwise. Add Node built-in tests, run npm test, document usage. Keep the implementation small, do not commit. Return the structured bridge report.');
let id;
try {
  const first=call('spawn','--repo',repo,'--task',task,'--config',config);id=first.workerId;wait(id);
  const before=call('status',id);call('review',id);
  const workspace=before.workspaceDir;
  evidence.initialTests=run(process.execPath,['--test'],workspace);
  run(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {add} from './index.js';assert.equal(add(2,3),5);assert.throws(()=>add(NaN,1),TypeError);"],workspace);
  call('steer',id,'--message','Correction: add an optional third numeric offset argument defaulting to zero, returning a+b+offset. Validate offset as finite numeric too. Extend the tests and README, run tests, and return structured report.');wait(id);
  const after=call('status',id);call('review',id);
  evidence.correctedTests=run(process.execPath,['--test'],workspace);
  run(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {add} from './index.js';assert.equal(add(2,3,4),9);assert.equal(add(2,3),5);assert.throws(()=>add(1,2,Infinity),TypeError);"],workspace);
  evidence.sameSession=before.sessionFile===after.sessionFile;evidence.sameChildPid=before.daemon.childPid===after.daemon.childPid;
  if(!evidence.sameSession||!evidence.sameChildPid)throw new Error('session unexpectedly restarted');
  call('accept',id,'--note','Native Mac demo independently verified before and after correction');
  evidence.sourceStatus=run('/usr/bin/git',['status','--porcelain']);if(evidence.sourceStatus)throw new Error('source changed');
  evidence.success=true;fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({success:true,sameSession:evidence.sameSession,sameChildPid:evidence.sameChildPid,evidence:path.join(root,'evidence.json')}));
} catch(err){if(id)try{call('stop',id)}catch{}throw err;}
