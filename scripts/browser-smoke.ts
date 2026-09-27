import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await mkdir('output', { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(process.env.SMOKE_AUDIO ? [`--use-file-for-fake-audio-capture=${resolve(process.env.SMOKE_AUDIO)}`] : [])] });
const results: any[] = [];
try {
  for (const transport of process.argv[2] ? [process.argv[2]] : ['webrtc', 'websocket']) {
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const OriginalPeer = window.RTCPeerConnection;
      (window as any).__peers = [];
      window.RTCPeerConnection = class extends OriginalPeer {
        constructor(configuration?: RTCConfiguration) { super(configuration); (window as any).__peers.push(this); }
        createDataChannel(label: string, options?: RTCDataChannelInit) {
          const channel = super.createDataChannel(label, options);
          (window as any).__dataEvents = {};
          channel.addEventListener('message', event => { const type = JSON.parse(event.data).type; (window as any).__dataEvents[type] = ((window as any).__dataEvents[type] ?? 0) + 1; });
          return channel;
        }
      };
    });
    const events: Record<string, number> = {};
    const errors: string[] = [];
    let sessionId = '';
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => {
      if (!socket.url().includes('/api/sessions/')) return;
      sessionId = socket.url().split('/sessions/')[1].split('/')[0];
      socket.on('framereceived', frame => {
        try {
          const event = JSON.parse(frame.payload.toString());
          events[event.type] = (events[event.type] ?? 0) + 1;
          if (event.type === 'error' || event.type === 'studio.error') errors.push(event.error?.message ?? event.message);
        } catch {}
      });
    });
    try {
      await page.goto(process.env.STUDIO_URL ?? 'http://localhost:3000');
      await page.getByRole('button', { name: '开始体验' }).waitFor();
      if (transport === 'webrtc') {
        await page.screenshot({ path: 'output/studio-desktop.png', fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: 'output/studio-mobile.png', fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1100 });
      } else {
        await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
      }
      await page.getByRole('button', { name: '开始体验' }).click();
      await page.getByRole('button', { name: '结束会话', exact: true }).waitFor({ timeout: 35_000 });
      await page.getByLabel('会话上下文').fill('你好，这是一次浏览器语音测试。');
      await page.getByLabel('上下文追加方式').selectOption('commentary');
      await page.getByRole('button', { name: '发送上下文' }).click();
      await page.getByRole('button', { name: '输入静音', exact: true }).click();
      await page.getByRole('button', { name: '取消输入静音', exact: true }).waitFor({ timeout: 5000 });
      await page.getByRole('button', { name: '取消输入静音', exact: true }).click();
      if (transport === 'websocket') {
        await page.evaluate(async id => {
          const config = await (await fetch('/api/config')).json();
          for (const event of [
            { type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请调用 get_demo_devices 查看模拟家电状态。' }] } },
            { type: 'response.create' },
          ]) {
            const response = await fetch(`/api/sessions/${id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Csrf': config.csrf }, body: JSON.stringify({ event }) });
            if (!response.ok) throw new Error(await response.text());
          }
        }, sessionId);
        await page.getByRole('button', { name: '批准并执行模拟工具' }).first().click({ timeout: 25_000 });
        await page.getByText('结果已提交（非执行回执）').first().waitFor({ timeout: 10_000 });
      }
      await page.waitForTimeout(transport === 'webrtc' ? 12_000 : 4000);
      const rtcStats = await page.evaluate(async () => {
        const peers = (window as any).__peers as RTCPeerConnection[];
        const stats = [];
        for (const peer of peers) {
          const report = await peer.getStats();
          stats.push({ connectionState: peer.connectionState, rtp: [...report.values()].filter(item => ['inbound-rtp', 'outbound-rtp'].includes(item.type)).map(item => ({ type: item.type, packetsReceived: item.packetsReceived, packetsSent: item.packetsSent, bytesReceived: item.bytesReceived, bytesSent: item.bytesSent })) });
        }
        return stats;
      });
      await page.screenshot({ path: `output/studio-${transport}-live.png`, fullPage: true });
      await page.getByRole('button', { name: '结束会话', exact: true }).click();
      await page.getByRole('button', { name: '开始新会话' }).waitFor({ timeout: 20_000 });
      results.push({ transport, events, dataChannelEvents: await page.evaluate(() => (window as any).__dataEvents), errors, rtcStats, finalUsageConfirmed: (events['session.closed'] ?? 0) > 0 });
    } catch (error) {
      errors.push(String(error));
      const alerts = await page.getByRole('alert').allTextContents();
      results.push({ transport, events, errors, alerts });
      await page.screenshot({ path: `output/studio-${transport}-failed.png`, fullPage: true });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
await writeFile(`output/browser-smoke${process.argv[2] ? `-${process.argv[2]}` : ''}.json`, JSON.stringify({ testedAt: new Date().toISOString(), syntheticSpeech: !!process.env.SMOKE_AUDIO, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
