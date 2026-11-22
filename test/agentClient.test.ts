import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentClient } from '../src/main/agentClient.ts'

const HOST = `
import { createInterface } from 'node:readline';
const send = data => process.stdout.write(JSON.stringify(data)+'\\n');
let seq=0;
const event=(req,name,data={})=>send({type:'event',seq:++seq,req,run_id:null,event:name,data});
createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line);
  if(req.jsonrpc!=='2.0') process.exit(9);
  const {id,method,params}=req;
  if(method==='initialize') return send({id,result:{protocol:1}});
  if(method==='shutdown') { send({id,result:{ok:true}}); return process.exit(0); }
  if(method==='before_ack') { event(id,'done'); return setTimeout(()=>send({id,result:{saved:true}}),10); }
  if(method==='command_error') { send({id,result:{accepted:true}}); event(id,'provider_setup',{error:'配置未保存'}); return event(id,'done'); }
  if(method==='reject') return send({id,error:{code:'busy',message:'当前正在执行任务'}});
  if(method==='echo_size') return send({id,result:{length:params.image.length}});
  if(method==='split_utf8') {
    const raw = Buffer.from(JSON.stringify({id,result:{text:'中文边界测试'}}) + '\\r\\n', 'utf8');
    const idx = raw.indexOf(Buffer.from('中', 'utf8')) + 1;
    process.stdout.write(raw.subarray(0, idx));
    setTimeout(() => process.stdout.write(raw.subarray(idx)), 10);
    return;
  }
  if(method==='oversize_no_nl') {
    const chunk = Buffer.alloc(1024 * 1024, 97);
    for (let i = 0; i < 11; i++) process.stdout.write(chunk);
    return;
  }
  if(method==='crash') return process.exit(17);
  if(method==='hang') return;
  send({id,result:{accepted:true}});
});
`

async function client(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'fd-client-'))
  const script = join(dir, 'host.mjs')
  await writeFile(script, HOST)
  const host = new AgentClient({ command: process.execPath, args: [script] })
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }) })
  await host.start()
  return host
}

test('控制命令等待done，即使done先于受理响应也不丢失', async t => {
  const host = await client(t)
  assert.deepEqual(await host.request('before_ack', {}, true), { saved: true })
  await assert.rejects(host.request('command_error', {}, true), /配置未保存/)
  await assert.rejects(host.request('reject'), /当前正在执行任务/)
})

test('大图片请求保持完整，进程死亡拒绝所有在途请求', async t => {
  const host = await client(t)
  const image = Buffer.alloc(1200 * 1024, 65).toString('base64')
  assert.deepEqual(await host.request('echo_size', { image }), { length: image.length })
  const hung = host.request('hang')
  const crashed = host.request('crash')
  await Promise.all([assert.rejects(hung, /内核已退出/), assert.rejects(crashed, /内核已退出/)])
  assert.equal(host.alive, false)
  await assert.rejects(host.request('echo_size', { image: '' }), /内核尚未连接/)
})

test('跨分片 UTF-8 与 CRLF 帧正常解码，无换行超大帧立即失败并终止子进程', async t => {
  const host = await client(t)
  assert.deepEqual(await host.request('split_utf8'), { text: '中文边界测试' })
  const disconnected = new Promise<Error>(resolve => host.once('disconnected', resolve))
  await assert.rejects(host.request('oversize_no_nl'), /超过大小上限/)
  const err = await disconnected
  assert.match(err.message, /超过大小上限/)
  assert.equal(host.alive, false)
})
