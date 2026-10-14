import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { DEFAULT_CONFIG } from '../shared/protocol';
import { sceneConfig } from '../shared/scenarios';
import type { KnowledgeMode } from '../shared/knowledge';

const origin = process.env.STUDIO_TEST_ORIGIN ?? 'http://localhost:3000';
const mode = (process.argv[2] ?? 'full') as KnowledgeMode;
const response = await fetch(`${origin}/api/config`);
const cookie = response.headers.get('set-cookie')!.split(';')[0];
const config = await response.json();
const headers = { cookie, origin, 'X-Studio-Csrf': config.csrf, 'Content-Type': 'application/json' };
const manifest = await (await fetch(`${origin}/api/knowledge`, { headers })).json();
const start = await fetch(`${origin}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ scene: 'knowledge', transport: 'websocket', session: sceneConfig('knowledge', { ...DEFAULT_CONFIG, model: config.deployment }, config.responsesDeployment), knowledge: { mode, revision: manifest.revision } }) });
const session = await start.json();
if (!start.ok) throw new Error(session.error);
const result = await new Promise<Record<string, unknown>>(resolve => {
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/sessions/${session.id}/events`, { headers: { cookie, origin } });
  const counts: Record<string, number> = {}; const errors: string[] = []; const modes: string[] = [];
  let answer = ''; let audio: ReturnType<typeof setInterval>; let timer: ReturnType<typeof setTimeout>; let done = false;
  const send = (event: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); };
  const close = () => { if (done) return; done = true; clearInterval(audio); send({ type: 'session.close' }); setTimeout(() => socket.close(), 12_000).unref(); };
  socket.on('open', () => {
    audio = setInterval(() => send({ type: 'session.input_audio.append', audio: Buffer.alloc(960).toString('base64') }), 20);
    send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请查知识库，星河实验室蓝鲸项目的预算多少，设备能借几天？请注明文档及位置。' }] } });
    send({ type: 'response.create' });
    timer = setTimeout(close, 100_000);
  });
  socket.on('message', data => {
    const event = JSON.parse(data.toString()); counts[event.type] = (counts[event.type] ?? 0) + 1;
    if (event.type === 'studio.rag.sources') modes.push(event.mode);
    if (event.type === 'error' || event.type === 'studio.error') { errors.push(event.message ?? event.error?.message ?? 'error'); close(); }
    if (event.type === 'response.event') {
      const nested = event.event; counts[nested.type] = (counts[nested.type] ?? 0) + 1;
      if (nested.type === 'response.output_text.delta') answer += nested.delta;
      if (nested.type === 'response.completed' && /7300|7,300/.test(answer) && /14/.test(answer)) setTimeout(close, 5000);
    }
    if (event.type === 'session.closed' || event.type === 'studio.disconnected') socket.close();
  });
  socket.on('error', e => { errors.push(e.message); close(); });
  socket.on('close', () => { clearInterval(audio); clearTimeout(timer); resolve({ deployment: config.responsesDeployment, requestedMode: mode, modes, counts, answer, errors, success: modes.length > 0 && /7300|7,300/.test(answer) && /14/.test(answer) && !errors.length }); });
});
const report = JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2);
await writeFile(`output/knowledge-live-${mode}-${Date.now()}.json`, report);
await writeFile(`output/knowledge-live-${mode}.json`, report);
console.log(JSON.stringify(result, null, 2));
if (!result.success) process.exitCode = 1;
