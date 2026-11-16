import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { buildSeatbeltProfile, buildSeatbeltArgv, canonicalPath, probeSeatbelt } from '../src/lib/seatbelt.ts';
import { workerPaths, ensureWorkerDirs } from '../src/lib/paths.ts';
import { computeDiff } from '../src/lib/git.ts';
import { buildChildEnv, loadConfig } from '../src/lib/config.ts';
import { NODE, cli, git, killTree, pidAlive, waitFor, makeRepo, tempDir, writeConfig, writeTask } from './helpers.ts';

const native = process.platform === 'darwin';
test('Seatbelt policy escapes path strings, limits writes, and denies network in review', () => {
  const policy = buildSeatbeltProfile({ readOnly: ['/tmp/read"(allow default)'], writable: ['/tmp/worker'], network: false });
  assert.ok(policy.startsWith('(version 1)\n(deny default)'));
  assert.ok(policy.includes('read\\"(allow default)'));
  assert.ok(!policy.includes('(allow network'));
  assert.ok(!policy.includes('(allow mach-lookup)'));
  assert.throws(() => canonicalPath('/tmp/x\n(allow default)'), /control characters/);
  const enabled = buildSeatbeltProfile({ readOnly: [], writable: [], network: true });
  assert.ok(enabled.includes('(remote ip "*:*")'));
  // The only Unix socket a worker may reach is mDNSResponder, which hostname resolution needs.
  const unixRules = enabled.split('\n').filter((line) => line.includes('unix-socket'));
  assert.deepEqual(unixRules, ['(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))']);
  assert.ok(!policy.includes('unix-socket'));
});

test('long worker state paths get a private short Unix socket path', () => {
  const h = tempDir();
  try {
    const p = workerPaths(path.join(h.dir, 'nested'.repeat(25)), '12345678-1234-4234-8234-123456789abc');
    ensureWorkerDirs(p);
    assert.ok(Buffer.byteLength(p.socket) <= 100);
    assert.equal(fs.statSync(path.dirname(p.socket)).mode & 0o777, 0o700);
    assert.equal(workerPaths(path.join(h.dir, 'other'.repeat(25)), p.id).socket === p.socket, false);
  } finally { h.cleanup(); }
});

function inside(argv: string[], cwd: string, env: Record<string, string> = {}): Promise<{code: number|null; out: string; err: string}> {
  return new Promise((resolve, reject) => {
    const c = spawn(argv[0], argv.slice(1), {cwd, env: {PATH:'/usr/bin:/bin:/usr/sbin:/sbin', HOME:cwd, ...env}});
    let out='',err=''; c.stdout.on('data',x=>out+=x); c.stderr.on('data',x=>err+=x);
    const timer=setTimeout(()=>{c.kill('SIGKILL');reject(new Error('sandbox test timed out'));},15000);
    c.on('error',reject); c.on('close',code=>{clearTimeout(timer);resolve({code,out,err});});
  });
}

test('native Seatbelt permits Node and work files but denies source files and symlink escapes', {skip: !native}, async () => {
  assert.ok(probeSeatbelt().ok, probeSeatbelt().detail);
  const h=tempDir();
  try {
    const w=path.join(h.dir,'work');fs.mkdirSync(w);
    const secret=path.join(h.dir,'private.txt');fs.writeFileSync(secret,'private');
    fs.symlinkSync(secret,path.join(w,'escape'));
    const script=`const fs=require('fs'); const attempt=(f)=>{try{f();return true}catch{return false}}; console.log(JSON.stringify({write:attempt(()=>fs.writeFileSync('ok','ok')),read:attempt(()=>fs.readFileSync(${JSON.stringify(secret)})),escape:attempt(()=>fs.readFileSync('escape')),outside:attempt(()=>fs.writeFileSync(${JSON.stringify(secret)},'changed'))}));`;
    const result=await inside(buildSeatbeltArgv({inner:[NODE,'-e',script],readOnly:[path.dirname(NODE)],writable:[w],network:true}),w);
    assert.equal(result.code,0,result.err);assert.deepEqual(JSON.parse(result.out),{write:true,read:false,escape:false,outside:false});
    assert.equal(fs.readFileSync(secret,'utf8'),'private');
  } finally{h.cleanup();}
});

test('native review policy blocks TCP and supervisor Unix sockets', {skip: !native}, async () => {
  const h=tempDir(); const server=net.createServer(c=>{c.on('error',()=>{});c.end('host')});
  const socket=path.join(h.dir,'host.sock'); const unix=net.createServer(c=>{c.on('error',()=>{});c.end('host')});
  try {
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    // Use the short socket helper because macOS temp directories can exceed sun_path.
    const p=workerPaths(h.dir,'12345678-1234-4234-8234-123456789abc');ensureWorkerDirs(p);
    await new Promise<void>(r=>unix.listen(p.socket,r));
    const port=(server.address() as net.AddressInfo).port;
    const script=`const net=require('net'); const attempt=o=>new Promise(r=>{const c=net.connect(o);c.on('connect',()=>{c.destroy();r(true)});c.on('error',()=>r(false));c.setTimeout(1000,()=>{c.destroy();r(false)})}); Promise.all([attempt({host:'127.0.0.1',port:${port}}),attempt({path:${JSON.stringify(p.socket)}})]).then(x=>console.log(JSON.stringify(x)));`;
    const a=await inside(buildSeatbeltArgv({inner:[NODE,'-e',script],readOnly:[path.dirname(NODE)],writable:[],network:false}),h.dir);
    assert.equal(a.code,0,a.err);assert.deepEqual(JSON.parse(a.out),[false,false]);
    const b=await inside(buildSeatbeltArgv({inner:[NODE,'-e',script],readOnly:[path.dirname(NODE)],writable:[],network:true}),h.dir);
    assert.equal(b.code,0,b.err);assert.deepEqual(JSON.parse(b.out),[true,false]);
  } finally { server.close();unix.close();h.cleanup(); }
});

test('native worker policy resolves hostnames through mDNSResponder; review policy does not', {skip: !native}, async () => {
  const h=tempDir();
  try {
    // The host's own name is answered by mDNSResponder locally, so this needs no network access.
    const script=`require('dns').lookup(require('os').hostname(),(e)=>console.log(e?e.code:'ok'))`;
    const worker=await inside(buildSeatbeltArgv({inner:[NODE,'-e',script],readOnly:[path.dirname(NODE)],writable:[],network:true}),h.dir);
    assert.equal(worker.code,0,worker.err);assert.equal(worker.out.trim(),'ok');
    const review=await inside(buildSeatbeltArgv({inner:[NODE,'-e',script],readOnly:[path.dirname(NODE)],writable:[],network:false}),h.dir);
    assert.equal(review.code,0,review.err);assert.notEqual(review.out.trim(),'ok');
  } finally{h.cleanup();}
});

test('native worker environment runs the real Git, so commits work inside Seatbelt without xcrun errors', {skip: !native}, async () => {
  const h=tempDir();
  try {
    const w=path.join(h.dir,'work');fs.mkdirSync(w);git(['init','-q'],w);
    const env=buildChildEnv(loadConfig(writeConfig(h)).config,{homeDir:w,agentDir:w,tmpDir:w});
    assert.ok(!env.PATH.startsWith('/usr/bin'),'the xcrun shim directory must not come first');
    const script='echo x > f && git add -A && git -c user.name=a -c user.email=a@b commit -qm t && git rev-list --count HEAD';
    const result=await inside(buildSeatbeltArgv({inner:['/bin/sh','-c',script],readOnly:[path.dirname(NODE)],writable:[w],network:true}),w,{PATH:env.PATH,TMPDIR:w});
    assert.equal(result.code,0,result.err);assert.equal(result.out.trim(),'1');
    assert.doesNotMatch(result.err,/xcrun|xcode-select|cache file/);
  } finally{h.cleanup();}
});

test('native worker lifecycle uses Seatbelt through correction, review and acceptance', {skip: !native}, () => {
  const h=tempDir();
  try {
    const {repo}=makeRepo(h);const config=writeConfig(h,{sandbox:'seatbelt',scenario:'two_runs'});const task=writeTask(h);const stateDir=path.join(h.dir,'state');
    const s=cli(['spawn','--repo',repo,'--task',task,'--config',config],{stateDir});assert.equal(s.code,0,s.stderr);
    const id=String(s.json?.workerId);assert.equal(s.json?.sandbox?.mode,'seatbelt');
    const first=cli(['wait',id],{stateDir});assert.equal(first.json?.state,'REVIEW_REQUIRED',first.stderr);
    const st=cli(['status',id],{stateDir});const pid=st.json?.daemon?.childPid;
    const steer=cli(['steer',id,'--message','fix the implementation'],{stateDir});assert.equal(steer.code,0,steer.stderr);
    const second=cli(['wait',id],{stateDir});assert.equal(second.json?.state,'REVIEW_REQUIRED',second.stderr);
    assert.equal(cli(['status',id],{stateDir}).json?.daemon?.childPid,pid);
    const review=cli(['review',id],{stateDir});assert.equal(review.code,0,review.stderr);
    assert.equal(cli(['accept',id],{stateDir}).json?.state,'COMPLETED');
    assert.equal(fs.readFileSync(path.join(repo,'index.ts'),'utf8'),'export const value = 1;\n');
  }finally{h.cleanup();}
});


test('native Git filters cannot write outside the review sandbox', {skip: !native}, async () => {
  const h=tempDir();
  try {
    const {repo,head}=makeRepo(h);const marker=path.join(h.dir,'escaped');
    fs.writeFileSync(path.join(repo,'index.ts'),'changed\n');
    fs.writeFileSync(path.join(repo,'.git/info/attributes'),'*.ts filter=probe\n');
    git(['config','filter.probe.clean',`touch '${marker}'; cat`],repo);
    const diff=await computeDiff(repo,head);assert.ok(diff.files.includes('index.ts'));
    assert.equal(fs.existsSync(marker),false);
  }finally{h.cleanup();}
});

test('native daemon death ends its process group and recovery preserves the session', {skip: !native}, async () => {
  const h=tempDir();
  try {
    const {repo}=makeRepo(h);const config=writeConfig(h,{sandbox:'seatbelt',scenario:'hang',extraPiArgs:['--spawn-background','background.pid'],limits:{runTimeoutSeconds:600}});const task=writeTask(h);const stateDir=path.join(h.dir,'state');
    const s=cli(['spawn','--repo',repo,'--task',task,'--config',config],{stateDir});assert.equal(s.code,0,s.stderr);
    const id=String(s.json?.workerId), guard=Number(s.json?.childPid), daemon=Number(s.json?.daemonPid), session=s.json?.sessionFile;
    const marker=path.join(String(s.json?.workspaceDir),'background.pid');
    assert.ok(await waitFor(()=>fs.existsSync(marker),5000));
    const detached=Number(fs.readFileSync(marker,'utf8'));
    killTree(daemon);
    assert.ok(await waitFor(()=>!pidAlive(detached),10000),'detached tool child must end too');
    assert.ok(await waitFor(()=>!pidAlive(guard),10000),'parent-death guard must end the child group');
    const r=cli(['recover',id],{stateDir});assert.equal(r.code,0,r.stderr);assert.equal(r.json?.state,'BLOCKED');assert.equal(r.json?.sessionFile,session);
    assert.equal(cli(['stop',id],{stateDir}).code,0);
  }finally{h.cleanup();}
});
