import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, type Event } from '../shared/protocol';
import { sceneConfig, type SceneId } from '../shared/scenarios';
import { ToolLedger } from '../server/tools';
import { evaluateSceneCall, initialSceneState } from '../server/scenes';

const scene = process.argv[2] === 'home' ? 'home' : 'search' satisfies SceneId;
const key = process.env.AZURE_OPENAI_API_KEY;
if (!key || key.startsWith('replace-')) throw new Error('请先配置私有 AZURE_OPENAI_API_KEY');
const endpoint = new URL('/openai/v1/live/sessions', process.env.AZURE_OPENAI_ENDPOINT);
endpoint.protocol = 'wss:';
const config = sceneConfig(scene, { ...DEFAULT_CONFIG, model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-live-1' }, process.env.RESPONSES_DEPLOYMENT ?? 'gpt-6-luna');

const result = await new Promise<Record<string, unknown>>(resolve => {
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  let finalUsage: unknown;
  let annotations = 0;
  let closed = false;
  let sessionClosed = false;
  let airConditionerSet = false;
  let sceneState = initialSceneState(scene);
  const ledger = new ToolLedger();
  const socket = new WebSocket(endpoint, { headers: { 'api-key': key }, handshakeTimeout: 10_000 });
  const send = (event: Event) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event_id: randomUUID(), ...event })); };
  const close = () => { if (closed) return; closed = true; send({ type: 'session.close' }); setTimeout(() => socket.terminate(), 5_000).unref(); };
  const timeout = setTimeout(() => { if (scene === 'home' && !airConditionerSet) errors.push('空调工具未成功执行'); close(); }, 18_000);
  const hardTimeout = setTimeout(() => socket.terminate(), 25_000);
  socket.on('open', () => send({ type: 'session.start', session: config }));
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as Event;
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === 'session.started') {
        send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: scene === 'search' ? '请使用 web_search 查找 Microsoft Learn 的 GPT-Live event API reference 官方页面，并返回页面标题及网址。' : '请把模拟空调开机，并调到 24 度。' }] } });
        send({ type: 'response.create' });
      }
      if (event.type === 'error' && !sessionClosed) { errors.push(`会话中：${String(event.error?.message ?? '模型错误').split(key).join('[redacted]')}`); close(); }
      if (event.type === 'response.event') {
        ledger.ingest(event);
        const nested = event.event;
        counts[`nested:${nested.type}`] = (counts[`nested:${nested.type}`] ?? 0) + 1;
        if (scene === 'home') {
          for (const call of ledger.calls.values()) {
            if (call.state !== 'pending') continue;
            ledger.claim(call.callId);
            const result = evaluateSceneCall(sceneState, call.name, call.arguments);
            sceneState = result.state;
            const output = JSON.parse(result.output);
            if (call.name === 'set_demo_air_conditioner' && output.changed?.power === true && output.changed?.temperature === 24) airConditionerSet = true;
            if (output.ok === false) errors.push(`模拟工具失败：${output.error}`);
            send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: call.callId, output: result.output } });
            call.state = 'submitted';
          }
          for (const batch of ledger.readyBatches()) { send({ type: 'response.create' }); ledger.batches.get(batch)!.continued = true; }
        }
        if (nested.type === 'response.output_text.annotation.added' && nested.annotation?.type === 'url_citation') annotations++;
        if (nested.type === 'response.completed') {
          annotations += (nested.response?.output ?? []).flatMap((item: any) => (item.content ?? []).flatMap((content: any) => content.annotations ?? [])).filter((item: any) => item.type === 'url_citation').length;
          if (scene === 'search' || airConditionerSet && counts['nested:response.completed'] >= 2 && !ledger.hasUnresolved()) close();
        }
        if (['response.failed', 'response.incomplete'].includes(nested.type)) { errors.push(`委派响应：${nested.type}`); close(); }
      }
      if (event.type === 'session.closed') { sessionClosed = true; finalUsage = event.usage; socket.close(); }
    } catch (error) { errors.push(String(error).split(key).join('[redacted]')); close(); }
  });
  socket.on('error', error => errors.push(error.message.split(key).join('[redacted]')));
  socket.on('close', () => { clearTimeout(timeout); clearTimeout(hardTimeout); resolve({ scene, deployment: process.env.RESPONSES_DEPLOYMENT ?? 'gpt-6-luna', counts, annotations, airConditionerSet, finalUsageConfirmed: counts['session.closed'] === 1, finalUsage, errors }); });
});

await mkdir('output', { recursive: true });
await writeFile(`output/scene-smoke-${scene}.json`, JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2));
console.log(JSON.stringify(result, null, 2));
if ((result.errors as string[]).length || scene === 'home' && result.airConditionerSet !== true) process.exitCode = 1;
