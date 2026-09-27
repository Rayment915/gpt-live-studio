import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { DEFAULT_CONFIG, type Event } from '../shared/protocol';
import { sceneConfig, type SceneId } from '../shared/scenarios';

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
  const socket = new WebSocket(endpoint, { headers: { 'api-key': key }, handshakeTimeout: 10_000 });
  const send = (event: Event) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event_id: randomUUID(), ...event })); };
  const close = () => { if (closed) return; closed = true; send({ type: 'session.close' }); setTimeout(() => socket.terminate(), 5_000).unref(); };
  const timeout = setTimeout(close, 18_000);
  const hardTimeout = setTimeout(() => socket.terminate(), 25_000);
  socket.on('open', () => send({ type: 'session.start', session: config }));
  socket.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as Event;
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      if (event.type === 'session.started') {
        send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: scene === 'search' ? '请使用 web_search 查找 Microsoft Learn 的 GPT-Live event API reference 官方页面，并返回页面标题及网址。' : '请调用 get_demo_devices 查询模拟设备。' }] } });
        send({ type: 'response.create' });
      }
      if (event.type === 'error') { errors.push(`${sessionClosed ? '关闭后' : '会话中'}：${String(event.error?.message ?? '模型错误').split(key).join('[redacted]')}`); close(); }
      if (event.type === 'response.event') {
        const nested = event.event;
        counts[`nested:${nested.type}`] = (counts[`nested:${nested.type}`] ?? 0) + 1;
        if (nested.type === 'response.output_text.annotation.added' && nested.annotation?.type === 'url_citation') annotations++;
        if (nested.type === 'response.completed') {
          annotations += (nested.response?.output ?? []).flatMap((item: any) => (item.content ?? []).flatMap((content: any) => content.annotations ?? [])).filter((item: any) => item.type === 'url_citation').length;
          close();
        }
        if (['response.failed', 'response.incomplete'].includes(nested.type)) { errors.push(`委派响应：${nested.type}`); close(); }
      }
      if (event.type === 'session.closed') { sessionClosed = true; finalUsage = event.usage; socket.close(); }
    } catch (error) { errors.push(String(error).split(key).join('[redacted]')); close(); }
  });
  socket.on('error', error => errors.push(error.message.split(key).join('[redacted]')));
  socket.on('close', () => { clearTimeout(timeout); clearTimeout(hardTimeout); resolve({ scene, deployment: process.env.RESPONSES_DEPLOYMENT ?? 'gpt-6-luna', counts, annotations, finalUsageConfirmed: counts['session.closed'] === 1, finalUsage, errors }); });
});

await mkdir('output', { recursive: true });
await writeFile(`output/scene-smoke-${scene}.json`, JSON.stringify({ testedAt: new Date().toISOString(), ...result }, null, 2));
console.log(JSON.stringify(result, null, 2));
