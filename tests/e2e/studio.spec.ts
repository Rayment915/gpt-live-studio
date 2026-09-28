import { expect, test, type WebSocketRoute } from '@playwright/test';
import { DEFAULT_CONFIG } from '../../shared/protocol';
import { sceneConfig } from '../../shared/scenarios';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({ json: { configured: true, endpoint: 'https://example.openai.azure.com', deployment: 'gpt-live-1', csrf: 'test-token', defaultConfig: DEFAULT_CONFIG, responsesDeployment: 'gpt-6-luna', maxSessionSeconds: 1800 } }));
});

test('renders studio, synchronizes configuration and preserves raw JSON errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '对话，不必等待。' })).toBeVisible();
  await page.getByRole('button', { name: '会议副驾', exact: true }).click();
  await expect(page.getByLabel('让模型如何与你交流')).toHaveValue(/会议副驾/);
  await expect(page.getByRole('button', { name: '口语练习', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '切换 JSON 配置编辑器' }).click();
  await page.getByLabel('Session JSON').fill('{broken');
  await expect(page.getByRole('button', { name: '开始体验' })).toBeDisabled();
  await page.getByLabel('Session JSON').fill(JSON.stringify(sceneConfig('meeting', DEFAULT_CONFIG, 'gpt-6-luna')));
  await expect(page.getByRole('button', { name: '开始体验' })).toBeEnabled();
});

test('session startup failure is actionable and releases microphone resources', async ({ page }) => {
  await page.route('**/api/sessions', route => route.fulfill({ status: 429, json: { error: '配额已满，请稍后重试' } }));
  await page.goto('/');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.getByRole('alert')).toContainText('配额已满', { timeout: 15_000 });
  await expect(page.getByRole('button', { name: '开始新会话' })).toBeEnabled();
});

test('microphone denial never creates a paid session', async ({ page }) => {
  let creates = 0;
  await page.route('**/api/sessions', route => { creates++; return route.fulfill({ status: 500, json: { error: 'unexpected' } }); });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
  await page.goto('/');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.getByRole('alert')).toContainText('麦克风权限被拒绝');
  expect(creates).toBe(0);
});

test('mobile has explicit workspaces and no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: '语音体验' })).toBeVisible();
  await page.getByRole('tab', { name: '会话设置' }).click();
  await expect(page.getByLabel('模型部署', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '委派任务' }).click();
  await expect(page.getByRole('heading', { name: '把复杂的事交给后台' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('event console never presents mock events as real data', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /事件控制台/ }).click();
  await expect(page.getByText('连接后显示真实事件，不填充模拟数据。')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送事件', exact: true })).toBeDisabled();
});

test('backend blocks bad origins, missing CSRF, and unowned sessions', async ({ request }) => {
  const bootstrap = await request.get('/api/config');
  const config = await bootstrap.json();
  const origin = new URL(bootstrap.url()).origin;
  expect(JSON.stringify(config)).not.toMatch(/AZURE_OPENAI_API_KEY|api-key|key1/);
  const badOrigin = await request.post('/api/sessions', { headers: { Origin: 'https://evil.invalid', 'X-Studio-Csrf': config.csrf }, data: {} });
  expect(badOrigin.status()).toBe(403);
  const missingCsrf = await request.post('/api/sessions', { headers: { Origin: origin }, data: {} });
  expect(missingCsrf.status()).toBe(403);
  const unowned = await request.post('/api/sessions/not-owned/commands', { headers: { Origin: origin, 'X-Studio-Csrf': config.csrf }, data: { event: { type: 'session.close' } } });
  expect(unowned.status()).toBe(400);
  const wrongScene = await request.post('/api/sessions', { headers: { Origin: origin, 'X-Studio-Csrf': config.csrf }, data: { transport: 'websocket', scene: 'home', session: sceneConfig('search', DEFAULT_CONFIG, config.responsesDeployment) } });
  expect(wrongScene.status()).toBe(400);
});

test('WebSocket file input needs no microphone and normalizes WAV to raw PCM', async ({ page }) => {
  let microphoneRequests = 0;
  const audioBytes: number[] = [];
  await page.exposeFunction('unexpectedMicrophone', () => { microphoneRequests++; });
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { await (window as any).unexpectedMicrophone(); throw new DOMException('Denied', 'NotAllowedError'); }; });
  await page.route('**/api/sessions', route => route.fulfill({ json: { id: 'test-session', session: DEFAULT_CONFIG } }));
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    socket.send(JSON.stringify({ type: 'session.started', session: DEFAULT_CONFIG, _seq: 1 }));
    socket.onMessage(data => {
      const event = JSON.parse(data.toString());
      if (event.type === 'session.input_audio.append') {
        const bytes = Buffer.from(event.audio, 'base64');
        expect(bytes.toString('ascii', 0, 4)).not.toBe('RIFF');
        audioBytes.push(bytes.length);
      }
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.getByRole('button', { name: '结束会话', exact: true })).toBeEnabled();
  const samples = 4800;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-test.wav', mimeType: 'audio/wav', buffer: wav });
  await expect.poll(() => audioBytes.reduce((sum, size) => sum + size, 0)).toBe(4800);
  expect(audioBytes.every(size => size % 2 === 0 && size <= 960)).toBe(true);
  expect(microphoneRequests).toBe(0);
});

test('search scene sends Luna delegation and displays only real source annotations', async ({ page }) => {
  let submitted: any;
  await page.route('**/api/sessions', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { id: 'test-session', session: submitted.session } }); });
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    socket.send(JSON.stringify({ type: 'session.started', session: sceneConfig('search', DEFAULT_CONFIG, 'gpt-6-luna'), _seq: 1 }));
    socket.send(JSON.stringify({ type: 'studio.scene.state', state: { scene: 'search' }, _seq: 2 }));
    socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'search-1', target: 'responses' }, offset_ms: 0, _seq: 3 }));
    socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'search-1', event: { type: 'response.completed', response: { output: [{ content: [{ annotations: [{ type: 'url_citation', title: '来源示例', url: 'https://example.org/result' }] }] }] } }, _seq: 4 }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: '边聊边搜', exact: true }).click();
  await expect(page.getByText(/真实网页搜索可能产生额外费用/)).toBeVisible();
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  expect(submitted.scene).toBe('search');
  expect(submitted.session.delegation.responses.model).toBe('gpt-6-luna');
  expect(submitted.session.delegation.responses.tools).toEqual([{ type: 'web_search' }]);
  await expect(page.getByRole('link', { name: '来源示例' })).toHaveAttribute('href', 'https://example.org/result');
});

test('home scene shows automatic simulated changes and recoverable tool errors', async ({ page }) => {
  await page.route('**/api/sessions', route => route.fulfill({ json: { id: 'test-session', session: sceneConfig('home', DEFAULT_CONFIG, 'gpt-6-luna') } }));
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    socket.send(JSON.stringify({ type: 'session.started', session: sceneConfig('home', DEFAULT_CONFIG, 'gpt-6-luna'), _seq: 1 }));
    socket.send(JSON.stringify({ type: 'studio.scene.state', state: { scene: 'home', devices: [{ id: 'living_light', name: '客厅灯', power: true, brightness: 80 }] }, _seq: 2 }));
    socket.send(JSON.stringify({ type: 'session.delegation.created', delegation: { id: 'home-1', target: 'responses' }, offset_ms: 0, _seq: 3 }));
    socket.send(JSON.stringify({ type: 'response.event', delegation_id: 'home-1', event: { type: 'response.completed', response: { output: [{ type: 'function_call' }] } }, _seq: 4 }));
    socket.send(JSON.stringify({ type: 'studio.tools', calls: [{ callId: 'call-1', delegationId: 'home-1', batchId: 'batch-1', name: 'set_demo_light', arguments: '{"temperature":24}', state: 'submitted', output: '{"ok":false,"error":"温度只能是空调的 18–30 整数"}' }], _seq: 5 }));
    socket.send(JSON.stringify({ type: 'studio.response.continued', batch_id: 'home-1:batch-1', _seq: 6 }));
    socket.send(JSON.stringify({ type: 'studio.scene.state', state: { scene: 'home', devices: [{ id: 'living_light', name: '客厅灯', power: true, brightness: 50 }] }, _seq: 7 }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.getByLabel('模拟家电状态')).toContainText('50%');
  await expect(page.getByText('参数无效，已反馈模型修正')).toBeVisible();
  await expect(page.getByText('后端继续处理中')).toBeVisible();
  await expect(page.getByRole('button', { name: '批准并执行模拟工具' })).toHaveCount(0);
});

test('transcript displays sentences rather than a bubble for every delta', async ({ page }) => {
  await page.route('**/api/sessions', route => route.fulfill({ json: { id: 'test-session', session: DEFAULT_CONFIG } }));
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    socket.send(JSON.stringify({ type: 'session.started', session: DEFAULT_CONFIG, _seq: 1 }));
    ['Hello', ' there', '.'].forEach((delta, index) => socket.send(JSON.stringify({ type: 'session.input_transcript.delta', delta, start_ms: index * 100, end_ms: (index + 1) * 100, _seq: index + 2 })));
    ['你', '好。'].forEach((delta, index) => socket.send(JSON.stringify({ type: 'session.output_transcript.delta', delta, start_ms: index * 100, end_ms: (index + 1) * 100, _seq: index + 5 })));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.locator('.transcript-fragment')).toHaveCount(2);
  await expect(page.locator('.transcript-fragment.input')).toContainText('Hello there.');
  await expect(page.locator('.transcript-fragment.output')).toContainText('你好。');
});

test('graceful closing waits for final usage and prevents new commands', async ({ page }) => {
  let stream: WebSocketRoute;
  await page.route('**/api/sessions', route => route.fulfill({ json: { id: 'test-session', session: DEFAULT_CONFIG } }));
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    stream = socket;
    socket.send(JSON.stringify({ type: 'session.started', session: DEFAULT_CONFIG, _seq: 1 }));
    socket.send(JSON.stringify({ type: 'session.usage.updated', usage: { seconds: 12 }, _seq: 2 }));
  });
  await page.route('**/api/sessions/test-session/commands', async route => {
    const event = route.request().postDataJSON().event;
    if (event.type === 'session.close') stream.send(JSON.stringify({ type: 'studio.closing', _seq: 3 }));
    await route.fulfill({ json: { sent: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  await page.getByRole('button', { name: '结束会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '等待最终用量…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发送上下文' })).toBeDisabled();
  stream!.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 15 }, _seq: 4 }));
  await stream!.close({ code: 1000 });
  await expect(page.getByRole('button', { name: '开始新会话' })).toBeEnabled();
  await expect(page.locator('.session-footer')).toContainText('15s');
  await expect(page.locator('.session-footer')).toContainText('已确认');
});

test('unexpected disconnection never fabricates final usage', async ({ page }) => {
  let stream: WebSocketRoute;
  await page.route('**/api/sessions', route => route.fulfill({ json: { id: 'test-session', session: DEFAULT_CONFIG } }));
  await page.routeWebSocket('**/api/sessions/test-session/events', socket => {
    stream = socket;
    socket.send(JSON.stringify({ type: 'session.started', session: DEFAULT_CONFIG, _seq: 1 }));
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'WebSocket', exact: true }).click();
  await page.getByLabel('输入源', { exact: true }).selectOption('file');
  await page.getByRole('button', { name: '开始体验' }).click();
  await expect(page.getByRole('button', { name: '结束会话', exact: true })).toBeEnabled();
  await stream!.close({ code: 1011, reason: 'synthetic disconnect' });
  await expect(page.getByText('未收到 session.closed，最终语音用量未确认；当前显示最近一次快照。')).toBeVisible();
});
