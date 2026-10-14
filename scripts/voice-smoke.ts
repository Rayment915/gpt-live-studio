// Explicit opt-in cloud smoke: starts/closes each built-in voice, without microphone input.
import 'dotenv/config';
import WebSocket from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, DOCUMENTED_LIVE_VOICES, LIVE_VOICES } from '../shared/protocol';

const endpoint = new URL('/openai/v1/live/sessions', process.env.AZURE_OPENAI_ENDPOINT);
endpoint.protocol = 'wss:';
const key = process.env.AZURE_OPENAI_API_KEY;
if (!key) throw new Error('Missing Azure key in private .env');
const results: { voice: string; started: boolean; closed: boolean; error?: string }[] = [];
const catalog = process.argv.includes('--catalog');
for (const voice of catalog ? DOCUMENTED_LIVE_VOICES : LIVE_VOICES) {
  const result = await new Promise<(typeof results)[number]>(resolve => {
    const result: (typeof results)[number] = { voice, started: false, closed: false };
    const socket = new WebSocket(endpoint, { headers: { 'api-key': key }, handshakeTimeout: 15_000 });
    const timer = setTimeout(() => { result.error = 'timeout'; socket.terminate(); }, 20_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start', session: { ...DEFAULT_CONFIG, model: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-live-1', audio: { output: { voice } } } })));
    socket.on('message', data => {
      const event = JSON.parse(data.toString());
      if (event.type === 'session.started') { result.started = true; socket.send(JSON.stringify({ type: 'session.close' })); }
      if (event.type === 'session.closed') { result.closed = true; socket.close(); }
      if (event.type === 'error') { result.error = JSON.stringify(event.error).split(key).join('[redacted]'); socket.close(); }
    });
    socket.on('error', error => { result.error = error.message.split(key).join('[redacted]'); });
    socket.on('close', () => { clearTimeout(timer); resolve(result); });
  });
  results.push(result);
  console.log(JSON.stringify(result));
}
await mkdir('output', { recursive: true });
await writeFile(`output/voice-smoke${catalog ? '-catalog' : ''}.json`, JSON.stringify({ testedAt: new Date().toISOString(), note: 'Session acceptance only; no pronunciation or listening evaluation.', results }, null, 2));
if (results.some(result => !result.started || !result.closed || result.error)) process.exitCode = 1;
