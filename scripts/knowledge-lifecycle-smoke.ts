import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { BlobServiceClient } from '@azure/storage-blob';
import WebSocket from 'ws';
import { DEFAULT_CONFIG } from '../shared/protocol';
import { sceneConfig } from '../shared/scenarios';

// Isolated container and Search prefix: never delete the interactive workspace library.
const container = `lifecycle-${randomUUID().slice(0, 8)}`;
const origin = 'http://localhost:3001';
const env: NodeJS.ProcessEnv = { ...process.env, PORT: '3001', APP_ORIGIN: origin, KNOWLEDGE_CONTAINER: container, KNOWLEDGE_INDEX_PREFIX: 'gpt-live-lifecycle-dev' };
const results: { name: string; passed: boolean }[] = [];
const children: ChildProcess[] = [];
const launch = (file: string) => { const process = spawn('node', ['--import', 'tsx', file], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(process); return process; };
const stop = async (child: ChildProcess) => { if (child.exitCode !== null) return; const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM'); await exited; };
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, timeout = 180_000): Promise<T> {
  const start = Date.now(); while (Date.now() - start < timeout) { try { const value = await read(); if (ready(value)) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); } throw new Error('Timed out waiting for lifecycle state');
}
let headers: Record<string, string> = {};
async function call(path: string, method = 'GET', body?: unknown) { const response = await fetch(`${origin}/api/knowledge${path}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
const state = async () => (await call('')).data;
const upload = async (name: string, text: string | Uint8Array) => { const form = new FormData(); form.append('file', new Blob([text as BlobPart]), name); const res = await fetch(`${origin}/api/knowledge/documents`, { method: 'POST', headers, body: form }); return { status: res.status, data: await res.json() }; };
const passed = (name: string) => { results.push({ name, passed: true }); console.log(name); };
try {
  launch('server/index.ts');
  await until(() => fetch(`${origin}/healthz`), r => r.ok, 30_000);
  const boot = await fetch(`${origin}/api/config`); const config = await boot.json();
  headers = { cookie: boot.headers.get('set-cookie')!.split(';')[0], origin, 'X-Studio-Csrf': config.csrf };
  const uploads = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(`lifecycle-${i}.md`, '测试项目蓝鲸预算7300元，设备借用14天。')));
  assert.equal(uploads.filter(r => r.status === 202).length, 3); assert.equal((await state()).documents.length, 3);
  passed('8 concurrent uploads reserve exactly 3 slots');
  const fresh = await fetch(`${origin}/api/config`); const otherCookie = fresh.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await (await fetch(`${origin}/api/knowledge`, { headers: { cookie: otherCookie } })).json()).documents.length, 3);
  passed('new browser owner sees persistent shared documents');
  let worker = launch('server/knowledge/worker.ts');
  const ready = await until(state, m => m.documents.every((d: any) => d.status === 'ready'));
  passed('durable queued uploads reach parsed and real IQ indexed state');
  await stop(worker); worker = launch('server/knowledge/worker.ts');
  assert.deepEqual((await state()).documents.map((d: any) => d.id), ready.documents.map((d: any) => d.id));
  passed('worker restart preserves ready document IDs');
  const id = ready.documents[0].id;
  const sessionResponse = await fetch(`${origin}/api/sessions`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: 'knowledge', transport: 'websocket', session: sceneConfig('knowledge', { ...DEFAULT_CONFIG, model: config.deployment }, config.responsesDeployment), knowledge: { mode: 'iq', revision: (await state()).revision } }) });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/sessions/${session.id}/events`, { headers });
  let invalidated = false;
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Knowledge session did not close after deletion')); }, 20_000);
    socket.on('message', data => {
      const event = JSON.parse(data.toString());
      if (event.type === 'studio.rag.invalidated') invalidated = true;
      if (['session.closed', 'studio.disconnected'].includes(event.type)) { clearTimeout(timer); socket.close(); resolve(); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
  await new Promise<void>(resolve => socket.once('open', resolve));
  assert.equal((await call(`/documents/${id}`, 'DELETE', { confirmed: true })).status, 202);
  await closed; assert.equal(invalidated, true);
  passed('deleting a bound document invalidates and closes the real Live session');
  assert.equal((await fetch(`${origin}/api/knowledge/documents/${id}/content`, { headers })).status, 404);
  await until(state, m => !m.documents.some((d: any) => d.id === id));
  passed('deletion immediately blocks content and releases slot after cleanup');
  await stop(worker);
  const pending = await upload('delete-queued.md', '此文档在处理开始前删除');
  assert.equal(pending.status, 202);
  await call(`/documents/${pending.data.id}`, 'DELETE', { confirmed: true });
  worker = launch('server/knowledge/worker.ts');
  await until(state, m => !m.documents.some((d: any) => d.id === pending.data.id));
  passed('queued deletion survives restart and is never indexed');
  const processing = await upload('delete-processing.pdf', await readFile('output/knowledge-fixtures/sample.pdf'));
  assert.equal(processing.status, 202);
  await until(state, m => m.documents.some((d: any) => d.id === processing.data.id && d.status === 'processing'));
  await call(`/documents/${processing.data.id}`, 'DELETE', { confirmed: true });
  await until(state, m => !m.documents.some((d: any) => d.id === processing.data.id));
  assert.equal((await fetch(`${origin}/api/knowledge/documents/${processing.data.id}/content`, { headers })).status, 404);
  passed('deletion during PDF processing never restores the document');
  const broken = await upload('corrupt.pdf', 'invalid PDF fixture'); assert.equal(broken.status, 202);
  await until(state, m => m.documents.some((d: any) => d.id === broken.data.id && d.status === 'failed'), 90_000);
  assert.equal((await state()).documents.find((d: any) => d.id === broken.data.id).attempts, 3);
  assert.equal((await upload('blocked.txt', 'test')).status, 400);
  passed('parse failure retries three times and still occupies its slot');
  assert.equal((await call(`/documents/${broken.data.id}/retry`, 'POST')).status, 202);
  passed('manual retry is accepted for failed processing');
  const generation = (await state()).generation;
  await call('', 'DELETE', { confirmed: true });
  const empty = await until(state, m => !m.deleting && m.generation !== generation && m.documents.length === 0);
  assert.ok(empty.generation); passed('whole-library deletion clears documents and dedicated IQ objects');
} catch (error) { results.push({ name: String(error), passed: false }); console.error(String(error)); process.exitCode = 1; }
finally {
  for (const child of children.reverse()) await stop(child);
  await writeFile('output/knowledge-lifecycle-smoke.json', JSON.stringify({ testedAt: new Date().toISOString(), container, storage: 'Azurite', retrieval: 'Azure AI Search Foundry IQ', results }, null, 2));
  if (results.every(r => r.passed)) await BlobServiceClient.fromConnectionString(env.KNOWLEDGE_STORAGE_CONNECTION_STRING!).getContainerClient(container).deleteIfExists();
}
