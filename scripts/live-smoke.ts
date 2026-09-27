import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, DEMO_TOOLS, type Event } from '../shared/protocol';
import { runDemoTool, ToolLedger } from '../server/tools';

const key = process.env.AZURE_OPENAI_API_KEY;
if (!key) throw new Error('Set AZURE_OPENAI_API_KEY in the private .env first.');
const endpoint = new URL('/openai/v1/live/sessions', process.env.AZURE_OPENAI_ENDPOINT);
endpoint.protocol = 'wss:';
const results: unknown[] = [];

async function run(mode: 'client' | 'responses') {
  return new Promise<void>(resolve => {
    const counts: Record<string, number> = {};
    const errors: string[] = [];
    const ledger = new ToolLedger();
    const socket = new WebSocket(endpoint, { headers: { 'api-key': key! }, handshakeTimeout: 15_000 });
    let audio: ReturnType<typeof setInterval> | undefined;
    let closing: ReturnType<typeof setTimeout> | undefined;
    let finalUsage: unknown;
    const started = Date.now();
    const send = (event: Event) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event_id: randomUUID(), ...event })); };
    const timeout = setTimeout(() => socket.terminate(), 35_000);
    socket.on('open', () => send({ type: 'session.start', session: { ...DEFAULT_CONFIG, model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-live-1', instructions: '请用中文简短说你好。', delegation: mode === 'client' ? { type: 'client' } : { type: 'responses', responses: { model: process.env.RESPONSES_DEPLOYMENT ?? 'gpt-5.4', tools: DEMO_TOOLS, tool_choice: 'auto', parallel_tool_calls: true } } } }));
    socket.on('message', data => {
      const event = JSON.parse(data.toString()) as Event;
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === 'error') errors.push(JSON.stringify(event.error).split(key!).join('[redacted]'));
      if (event.type === 'session.started') {
        audio = setInterval(() => send({ type: 'session.input_audio.append', audio: Buffer.alloc(960).toString('base64') }), 20);
        send({ type: 'session.thinking.append', delegation_id: null, content: '这是一次短时协议测试。' });
        send({ type: 'session.instructions.append', delegation_id: null, content: '请回答简洁。' });
        send({ type: 'session.commentary.append', delegation_id: null, content: '你好，语音连接测试完成。' });
        send({ type: 'session.input_audio.mute' });
        send({ type: 'session.input_audio.unmute' });
        if (mode === 'responses') {
          send({ type: 'session.update', session: { delegation: { type: 'responses', responses: { model: process.env.RESPONSES_DEPLOYMENT ?? 'gpt-5.4', tools: DEMO_TOOLS, tool_choice: 'auto', parallel_tool_calls: true } } } });
          send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请调用 get_current_time 查询 Asia/Shanghai 当前时间。' }] } });
          send({ type: 'response.create' });
        }
        closing = setTimeout(() => { clearInterval(audio); send({ type: 'session.close' }); }, mode === 'client' ? 6500 : 15_000);
      }
      ledger.ingest(event);
      if (event.type === 'response.event') {
        const nested = event.event;
        counts[`nested:${nested.type}`] = (counts[`nested:${nested.type}`] ?? 0) + 1;
        for (const call of ledger.calls.values()) {
          if (call.state !== 'pending') continue;
          ledger.claim(call.callId);
          try {
            const output = JSON.stringify(runDemoTool(call.name, JSON.parse(call.arguments)));
            send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: call.callId, output } });
            call.state = 'submitted';
          } catch (error) { errors.push(String(error)); }
        }
        for (const batch of ledger.readyBatches()) { send({ type: 'response.create' }); ledger.batches.get(batch)!.continued = true; }
      }
      if (event.type === 'session.closed') { finalUsage = event.usage; socket.close(); }
    });
    socket.on('error', error => errors.push(error.message.split(key!).join('[redacted]')));
    socket.on('close', () => {
      clearTimeout(timeout); clearTimeout(closing); clearInterval(audio);
      const result = { mode, durationMs: Date.now() - started, counts, finalUsage, errors };
      console.log(JSON.stringify(result, null, 2)); results.push(result); resolve();
    });
  });
}

await run('client');
await run('responses');
await mkdir('output', { recursive: true });
await writeFile('output/live-smoke.json', JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
