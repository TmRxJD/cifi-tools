'use strict';
// Drive the real pool module with Worker protocol events, without WASM or child processes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const source = fs.readFileSync(path.join(__dirname,'eval-pool.js'),'utf8');

function rig({throwAt=-1}={}) {
  const workers=[];
  class Worker extends EventEmitter {
    constructor() {
      super();
      if (workers.length===throwAt) throw new Error('constructor failed');
      this.terminated=0;
      this.messages=[];
      this.reply=true;
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
      if (!this.reply) return;
      queueMicrotask(()=>this.emit('message',{id:message.id,
        results:message.pairs.map(pair=>({value:pair.value,iterations:message.iterations}))}));
    }
    terminate() {
      this.terminated++;
      if(this.terminationError)return Promise.reject(this.terminationError);
      queueMicrotask(()=>this.emit('exit',0));return Promise.resolve(0);
    }
  }
  const module={exports:{}};
  vm.runInNewContext(source,{module,__dirname,require:name=>name==='worker_threads'?{Worker}:require(name)});
  return {pool:new module.exports.EvalPool('controlled',{},2),workers};
}

// Failure events have already been delivered. An unsettled promise after the next event-loop
// turn is a protocol hang, not slow simulation; there is no arbitrary multi-second timeout.
async function settles(promise) {
  const pending=Symbol('unsettled');
  const result=await Promise.race([promise.then(value=>({value}),error=>({error})),
    new Promise(resolve=>setImmediate(()=>resolve(pending)))]);
  assert.notEqual(result,pending,'pool promise remained pending after its failure event');
  return result;
}
async function rejects(promise,pattern) {
  const result=await settles(promise);
  assert(result.error, 'expected rejection');
  assert.match(String(result.error),pattern);
}
async function running() {
  const state=rig();
  const started=state.pool.start();
  state.workers.forEach(worker=>worker.emit('message',{type:'ready'}));
  assert.equal((await settles(started)).value,state.pool);
  return state;
}
let checked=0;
async function check(name,fn) {await fn();checked++;console.log(`PASS ${name}`);}
async function main() {
  await check('boot error rejects start and terminates every owned worker',async()=>{
    const {pool,workers}=rig();const started=pool.start();
    workers[0].emit('error',new Error('boot failed'));
    try {await rejects(started,/boot failed/);assert(workers.every(worker=>worker.terminated===1));}
    finally {await pool.destroy();}
  });
  for (const code of [0,7]) await check(`boot exit ${code} rejects start`,async()=>{
    const {pool,workers}=rig();const started=pool.start();workers[0].emit('exit',code);
    try {await rejects(started,new RegExp(`code ${code}`));assert(workers.every(worker=>worker.terminated===1));}
    finally {await pool.destroy();}
  });
  for (const errorMessage of [{error:'init without id'},{id:-1,error:'legacy init failure'}]) {
    await check(`ready followed by ${errorMessage.error} cannot pass startup`,async()=>{
      const {pool,workers}=rig();
      const started=pool.start();workers.forEach(worker=>{worker.reply=false;worker.emit('message',{type:'ready'});});
      workers[0].emit('message',errorMessage);
      try {await rejects(started,/init/);assert(workers.every(worker=>worker.terminated===1));}
      finally {await pool.destroy();}
    });
  }
  await check('partial constructor failure tears down prior workers',async()=>{
    const {pool,workers}=rig({throwAt:1});
    await rejects(pool.start(),/constructor failed/);
    assert.equal(workers.length,1);assert.equal(workers[0].terminated,1);
    await pool.destroy();
  });
  await check('startup preserves boot cause and termination failures after trying every worker',async()=>{
    const {pool,workers}=rig();const started=pool.start();
    workers[0].terminationError=new Error('startup termination failed');
    workers[0].emit('error',new Error('original boot cause'));
    const {error}=await settles(started);
    assert.equal(error?.name,'AggregateError');
    assert.match(String(error.cause),/original boot cause/);
    assert(error.errors.some(failure=>String(failure).includes('startup termination failed')));
    assert(workers.every(worker=>worker.terminated===1));
    await rejects(pool.destroy(),/cleanup failed/);
  });
  for (const event of ['error','exit 0','exit 7']) await check(`${event} rejects all outstanding batches`,async()=>{
    const {pool,workers}=await running();workers.forEach(worker=>{worker.reply=false;});
    const a=pool.evaluate([{value:1},{value:2}],100);
    const b=pool.evaluate([{value:3}],200);
    if(event==='error')workers[0].emit('error',new Error('midbatch failed'));else workers[0].emit('exit',Number(event.slice(5)));
    await Promise.all([rejects(a,/midbatch failed|code [07]/),rejects(b,/midbatch failed|code [07]/)]);
    await pool.destroy();assert(workers.every(worker=>worker.terminated===1));
  });
  await check('idle worker exit fails subsequent evaluation',async()=>{
    const {pool,workers}=await running();workers[0].emit('exit',0);
    await rejects(pool.evaluate([{value:1}],100),/code 0/);await pool.destroy();
  });
  await check('destroy rejects startup and pending work and is idempotent',async()=>{
    const first=rig();const boot=first.pool.start();await first.pool.destroy();
    await rejects(boot,/destroy/);await first.pool.destroy();
    assert(first.workers.every(worker=>worker.terminated===1));
    const second=await running();second.workers.forEach(worker=>{worker.reply=false;});
    const batch=second.pool.evaluate([{value:1}],100);await second.pool.destroy();
    await rejects(batch,/destroy/);await second.pool.destroy();
    await rejects(second.pool.start(),/destroy/);
    assert(second.workers.every(worker=>worker.terminated===1));
  });
  await check('synchronous dispatch failure rejects and tears down ownership',async()=>{
    const {pool,workers}=await running();
    workers[0].postMessage=()=>{throw new Error('dispatch failed');};
    await rejects(pool.evaluate([{value:1},{value:2}],100),/dispatch failed/);
    await pool.destroy();assert(workers.every(worker=>worker.terminated===1));
  });
  await check('a per-request evaluation error is forwarded without changing later values',async()=>{
    const {pool,workers}=await running();workers[0].reply=false;
    const batch=pool.evaluate([{value:1}],100);
    workers[0].emit('message',{id:workers[0].messages.at(-1).id,error:'invalid allocation'});
    await rejects(batch,/invalid allocation/);
    workers[0].reply=true;
    assert.equal((await pool.evaluate([{value:9}],200))[0].value,9);
    await pool.destroy();
  });
  await check('destroy reports termination rejection and still attempts all owned workers',async()=>{
    const {pool,workers}=await running();workers[0].terminationError=new Error('destroy termination failed');
    const {error}=await settles(pool.destroy());
    assert.equal(error?.name,'AggregateError');
    assert(error.errors.some(failure=>String(failure).includes('destroy termination failed')));
    assert(workers.every(worker=>worker.terminated===1));
    await rejects(pool.destroy(),/cleanup failed/);
    assert(workers.every(worker=>worker.terminated===1),'repeated destroy must not lose error or terminate twice');
  });
  await check('healthy startup, ordered batches and repeated calls preserve values',async()=>{
    const {pool,workers}=await running();
    assert.equal(await pool.start(),pool);assert.equal(workers.length,2);
    for(const [values,iterations] of [[[3,1,4,2],100],[[9],200],[[],300]]) {
      const result=await pool.evaluate(values.map(value=>({value})),iterations);
      assert.deepEqual(JSON.parse(JSON.stringify(result)),values.map(value=>({value,iterations})));
    }
    await pool.destroy();assert(workers.every(worker=>worker.terminated===1));
  });
  assert(checked>=11,'no lifecycle cases exercised');
  console.log(`PASS eval-pool lifecycle: ${checked} protocol cases; no WASM jobs`);
}
main().catch(error=>{console.error(`FAIL ${error.stack||error}`);process.exitCode=1;});
