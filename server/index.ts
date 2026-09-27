import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { DEFAULT_CONFIG, object, safeEvent, validateCommand, validateConfig, type Event, type SessionConfig, type Transport } from '../shared/protocol.js';
import { isSceneId, validateSceneConfig, type SceneId } from '../shared/scenarios.js';
import { allowedEndpoint, originAllowed, parseCookie, sameToken, validateAdminPasswordHash, verifyAdminPassword } from './security.js';
import { runDemoTool, ToolLedger } from './tools.js';
import { evaluateSceneCall, initialSceneState, type SceneState } from './scenes.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!process.env.AZURE_OPENAI_ENDPOINT) throw new Error('必须设置 AZURE_OPENAI_ENDPOINT');
const endpoint = allowedEndpoint(process.env.AZURE_OPENAI_ENDPOINT);
const apiKey = process.env.AZURE_OPENAI_API_KEY ?? '';
const configured = !!apiKey && !apiKey.startsWith('replace-');
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-live-1';
const responsesDeployment = process.env.RESPONSES_DEPLOYMENT ?? 'gpt-6-luna';
const maxSessions = Number(process.env.MAX_SESSIONS ?? 4);
const maxDuration = Number(process.env.MAX_SESSION_SECONDS ?? 1800) * 1000;
const authMode = process.env.AUTH_MODE ?? (production ? '' : 'local');
const adminPasswordHash = process.env.STUDIO_ADMIN_PASSWORD_HASH ?? '';
const origins = new Set((process.env.APP_ORIGIN ?? `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map(value => value.trim()));
if (authMode === 'local' && !['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.ALLOW_PRIVATE_CONTAINER !== 'true') throw new Error('非回环地址必须启用 AUTH_MODE=password；私有容器测试可显式设置 ALLOW_PRIVATE_CONTAINER=true');
if (!['local', 'password'].includes(authMode)) throw new Error('AUTH_MODE 必须是 local 或 password；生产环境必须显式配置');
if (authMode === 'password') {
  validateAdminPasswordHash(adminPasswordHash);
  if (production && [...origins].some(origin => !origin.startsWith('https://'))) throw new Error('密码登录必须使用 HTTPS APP_ORIGIN');
}

type Owner = { id: string; csrf: string; expires: number; principal: string; creating: boolean };
type Live = {
  id: string; owner: string; config: SessionConfig; transport: Transport; upstream: WebSocket;
  sceneState?: SceneState;
  status: 'ready' | 'closing' | 'closed'; ring: Event[]; seq: number; clients: Set<WebSocket>;
  tools: ToolLedger; delegations: Set<string>; expires: ReturnType<typeof setTimeout>;
  idle?: ReturnType<typeof setTimeout>; closeTimer?: ReturnType<typeof setTimeout>;
};
const owners = new Map<string, Owner>();
const loginSessions = new Map<string, number>();
const sessions = new Map<string, Live>();
const alive = new WeakMap<WebSocket, boolean>();
let creatingCount = 0;
let loginFailures = 0;
let loginWindowEnds = 0;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'microphone=(self), camera=()');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${production ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' https://${endpoint.hostname} wss://${endpoint.hostname}; form-action 'self'; frame-ancestors 'none'; base-uri 'self'`);
  if (authMode === 'password') response.setHeader('Cache-Control', 'no-store');
  if (request.path.startsWith('/api')) response.setHeader('Cache-Control', 'no-store');
  next();
});
app.get('/healthz', (_request, response) => response.json({ status: 'ok' }));

function principal(headers: Record<string, any>): string {
  if (authMode === 'local') return 'local';
  if (authMode === 'password') {
    const token = parseCookie(headers.cookie, 'studio_login');
    if (!token || (loginSessions.get(token) ?? 0) <= Date.now()) throw new Error('请先登录');
    return token;
  }
  throw new Error('认证模式未配置');
}

if (authMode === 'password') {
  const loginPage = (failed: boolean) => `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录 · GPT-Live Studio</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f6fc;font:16px system-ui,sans-serif;color:#142b4a}main{width:min(90vw,360px);background:white;padding:36px;border:1px solid #d7e2f4;border-radius:16px;box-shadow:0 18px 50px #16335916}h1{font-size:24px;margin:0 0 8px}p{color:#5a6d86;margin:0 0 24px}label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #afc0d9;border-radius:8px;font:inherit}button{width:100%;margin-top:24px;padding:13px;background:#2462db;border:0;border-radius:8px;color:white;font:inherit;cursor:pointer}.error{color:#b42318;margin:16px 0 0}</style></head><body><main><h1>GPT-Live Studio</h1><p>登录后开始实时语音体验</p><form action="/login" method="post"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required autofocus><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">登录</button></form>${failed ? '<p class="error" role="alert">用户名或密码错误，请重试。</p>' : ''}</main></body></html>`;
  app.get('/login', (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try { principal(request.headers); return void response.redirect(303, '/'); } catch { response.type('html').send(loginPage(request.query.failed === '1')); }
  });
  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== 'null' && !originAllowed(request.headers.origin, origins)) || (request.headers.origin === 'null' && request.headers['sec-fetch-site'] !== 'same-origin')) return void response.sendStatus(403);
    if (Date.now() >= loginWindowEnds) { loginFailures = 0; loginWindowEnds = Date.now() + 5 * 60_000; }
    if (loginFailures >= 10) { response.setHeader('Retry-After', String(Math.ceil((loginWindowEnds - Date.now()) / 1000))); return void response.status(429).send('登录尝试过多，请稍后再试'); }
    if (!verifyAdminPassword(adminPasswordHash, request.body?.username, request.body?.password)) { loginFailures++; return void response.redirect(303, '/login?failed=1'); }
    loginFailures = 0;
    const token = randomBytes(32).toString('hex');
    loginSessions.set(token, Date.now() + 8 * 3600_000);
    response.setHeader('Set-Cookie', `studio_login=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production ? '; Secure' : ''}`);
    response.redirect(303, '/');
  });
  app.post('/logout', (request, response) => {
    try {
      const identity = principal(request.headers);
      const ownerId = parseCookie(request.headers.cookie, 'studio_owner');
      const owner = ownerId ? owners.get(ownerId) : undefined;
      if (!owner || owner.principal !== identity || !originAllowed(request.headers.origin, origins) || !sameToken(request.headers['x-studio-csrf'] as string, owner.csrf)) return void response.sendStatus(403);
      loginSessions.delete(identity);
      owners.delete(owner.id);
      for (const live of sessions.values()) if (live.owner === owner.id) closeLive(live, '用户退出登录');
      response.setHeader('Set-Cookie', ['studio_login=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'studio_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'].map(cookie => cookie + (production ? '; Secure' : '')));
      response.sendStatus(204);
    } catch { response.sendStatus(401); }
  });
  app.use((request, response, next) => {
    try { principal(request.headers); next(); }
    catch { if (request.path.startsWith('/api')) response.status(401).json({ error: '请先登录' }); else response.redirect(303, '/login'); }
  });
}

app.use('/api', (request, response, next) => {
  try {
    const identity = principal(request.headers);
    if (request.headers['sec-fetch-site'] === 'cross-site') return void response.status(403).json({ error: '拒绝跨站请求' });
    if (request.headers.origin && !originAllowed(request.headers.origin, origins)) return void response.status(403).json({ error: '请求来源不被允许' });
    const id = parseCookie(request.headers.cookie, 'studio_owner');
    let owner = id ? owners.get(id) : undefined;
    if (owner && (owner.expires < Date.now() || owner.principal !== identity)) owner = undefined;
    if (!owner && request.method === 'GET' && request.path === '/config') {
      if (owners.size > 1000) throw new Error('访问会话过多，请稍后重试');
      owner = { id: randomBytes(32).toString('hex'), csrf: randomBytes(32).toString('hex'), expires: Date.now() + 8 * 3600_000, principal: identity, creating: false };
      owners.set(owner.id, owner);
      response.setHeader('Set-Cookie', `studio_owner=${owner.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production ? '; Secure' : ''}`);
    }
    if (!owner) return void response.status(401).json({ error: '请刷新页面建立应用会话' });
    if (request.method !== 'GET' && (!originAllowed(request.headers.origin, origins) || !sameToken(request.headers['x-studio-csrf'] as string, owner.csrf))) return void response.status(403).json({ error: '来源或安全令牌无效，请刷新页面' });
    response.locals.owner = owner;
    next();
  } catch (error) { response.status(401).json({ error: message(error) }); }
});

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

app.get('/api/config', (_request, response) => response.json({ configured, endpoint: endpoint.origin, deployment, responsesDeployment, csrf: response.locals.owner.csrf, authMode, defaultConfig: { ...DEFAULT_CONFIG, model: deployment }, maxSessionSeconds: maxDuration / 1000 }));

function publish(live: Live, event: Event) {
  const safe = event.type === 'session.output_audio.delta' ? event : safeEvent(event, apiKey);
  const frame = { ...safe, _seq: ++live.seq };
  if (event.type !== 'session.output_audio.delta') {
    live.ring.push(frame);
    if (live.ring.length > 500) live.ring.shift();
  }
  for (const client of live.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.bufferedAmount > 4 * 1024 * 1024) { client.close(1013, 'Slow consumer'); continue; }
    client.send(JSON.stringify(frame));
  }
}

function upstreamSend(live: Live, event: Event) {
  if (live.upstream.readyState !== WebSocket.OPEN) throw new Error('服务连接已断开');
  if (live.upstream.bufferedAmount > 2 * 1024 * 1024) throw new Error('音频发送积压，请结束会话后重试');
  live.upstream.send(JSON.stringify(event));
}

function toolsUpdated(live: Live) {
  publish(live, { type: 'studio.tools', calls: [...live.tools.calls.values()] });
}

function continueTools(live: Live) {
  if (live.status !== 'ready') return;
  for (const batchId of live.tools.readyBatches()) {
    upstreamSend(live, { type: 'response.create', event_id: randomUUID() });
    live.tools.batches.get(batchId)!.continued = true;
    publish(live, { type: 'studio.response.continued', batch_id: batchId });
  }
}

function autoSubmitSceneTools(live: Live) {
  if (!live.sceneState || live.status !== 'ready') return;
  for (const pending of live.tools.calls.values()) {
    if (pending.state !== 'pending') continue;
    const call = live.tools.claim(pending.callId);
    const previousState = live.sceneState;
    const result = evaluateSceneCall(previousState, call.name, call.arguments);
    try {
      submitTool(live, call.callId, result.output);
      live.sceneState = result.state;
      if (result.state !== previousState) publish(live, { type: 'studio.scene.state', state: live.sceneState });
    } catch (error) {
      if (call.state === 'running') call.state = 'pending';
      toolsUpdated(live);
      throw error;
    }
  }
}

function closeLive(live: Live, reason: string) {
  if (live.status !== 'ready') return;
  live.status = 'closing';
  publish(live, { type: 'studio.closing', reason });
  try { upstreamSend(live, { type: 'session.close', event_id: randomUUID() }); } catch { live.upstream.terminate(); }
  live.closeTimer = setTimeout(() => live.upstream.terminate(), 12_000);
}

function bindLive(id: string, owner: string, config: SessionConfig, transport: Transport, upstream: WebSocket, initial: Event[], scene?: SceneId): Live {
  const live: Live = { id, owner, config, transport, upstream, sceneState: scene ? initialSceneState(scene) : undefined, status: 'ready', ring: [], seq: 0, clients: new Set(), tools: new ToolLedger(), delegations: new Set(), expires: setTimeout(() => closeLive(live, '应用会话时长上限'), maxDuration) };
  live.idle = setTimeout(() => closeLive(live, '浏览器未连接'), 20_000);
  sessions.set(id, live);
  alive.set(upstream, true);
  upstream.on('pong', () => alive.set(upstream, true));
  const handle = (event: Event) => {
    if (event.type === 'session.started' || event.type === 'session.updated') {
      if (event.session) {
        for (const key of ['model', 'instructions', 'audio', 'delegation'] as const) {
          if (key in event.session) (live.config as any)[key] = event.session[key];
        }
      }
    }
    if (event.type === 'session.delegation.created' && typeof event.delegation?.id === 'string') live.delegations.add(event.delegation.id);
    live.tools.ingest(event);
    publish(live, event);
    if (event.type === 'response.event') { autoSubmitSceneTools(live); toolsUpdated(live); continueTools(live); }
    if (event.type === 'session.closed') {
      live.status = 'closed';
      clearTimeout(live.closeTimer);
      upstream.close();
    }
  };
  upstream.on('message', data => {
    try { const event = JSON.parse(data.toString()); if (object(event) && typeof event.type === 'string') handle(event as Event); }
    catch (error) { publish(live, { type: 'studio.error', message: message(error) }); }
  });
  upstream.on('error', error => publish(live, { type: 'studio.error', message: message(error) }));
  upstream.on('close', () => {
    const confirmed = live.status === 'closed';
    live.status = 'closed';
    clearTimeout(live.expires); clearTimeout(live.idle); clearTimeout(live.closeTimer);
    publish(live, { type: 'studio.disconnected', final_usage_confirmed: confirmed });
    for (const client of live.clients) client.close(1000, 'Session ended');
    setTimeout(() => sessions.delete(id), 30_000).unref();
  });
  initial.forEach(handle);
  if (live.sceneState) publish(live, { type: 'studio.scene.state', state: live.sceneState });
  return live;
}

async function connectUpstream(path: string, config?: SessionConfig): Promise<{ socket: WebSocket; initial: Event[] }> {
  const url = new URL(path, endpoint); url.protocol = 'wss:';
  return new Promise((resolveConnection, reject) => {
    const socket = new WebSocket(url, { headers: { 'api-key': apiKey }, handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024 });
    const initial: Event[] = [];
    const timer = setTimeout(() => fail(new Error('连接模型超时（20 秒），请检查部署、网络与密钥')), 20_000);
    const cleanup = () => { clearTimeout(timer); socket.removeListener('error', fail); socket.removeListener('close', closed); socket.removeListener('message', received); };
    const fail = (error: Error) => { cleanup(); socket.on('error', () => {}); socket.terminate(); reject(error); };
    const closed = () => fail(new Error('模型在会话启动前关闭连接'));
    const success = () => { cleanup(); resolveConnection({ socket, initial }); };
    const received = (data: WebSocket.RawData) => {
      try {
        const event = JSON.parse(data.toString()) as Event;
        initial.push(event);
        if (event.type === 'error') fail(new Error(event.error?.message ?? '会话配置被拒绝'));
        else if (event.type === 'session.started') success();
      } catch (error) { fail(error as Error); }
    };
    socket.on('error', fail); socket.on('close', closed);
    if (config) socket.on('message', received);
    socket.on('open', () => config ? socket.send(JSON.stringify({ type: 'session.start', event_id: randomUUID(), session: config })) : success());
  });
}

app.post('/api/sessions', async (request, response) => {
  const owner = response.locals.owner as Owner;
  if (!configured) return void response.status(503).json({ error: '后端尚未设置 AZURE_OPENAI_API_KEY，请配置 .env 并重启' });
  if (owner.creating || [...sessions.values()].some(live => live.owner === owner.id && live.status !== 'closed')) return void response.status(409).json({ error: '请先结束当前会话' });
  if ([...sessions.values()].filter(live => live.status !== 'closed').length + creatingCount >= maxSessions) return void response.status(429).json({ error: '当前体验会话已满，请稍后重试' });
  owner.creating = true; creatingCount++;
  let active: Live | undefined;
  let detachedSessionId: string | undefined;
  try {
    const config = validateConfig(request.body.session);
    if (config.model !== deployment) throw new Error('该 Studio 只允许服务器配置的语音部署');
    const scene = request.body.scene;
    if (scene !== undefined && !isSceneId(scene)) throw new Error('未知场景');
    if (scene) validateSceneConfig(scene, config, responsesDeployment);
    const transport = request.body.transport as Transport;
    if (!['webrtc', 'websocket'].includes(transport)) throw new Error('transport 必须是 webrtc 或 websocket');
    const id = randomUUID();
    if (transport === 'websocket') {
      const { socket, initial } = await connectUpstream('/openai/v1/live/sessions', config);
      active = bindLive(id, owner.id, config, transport, socket, initial, scene);
      if (response.destroyed) closeLive(active, '浏览器已离开');
      response.json({ id, session: initial.find(event => event.type === 'session.started')?.session });
    } else {
      if (typeof request.body.sdp !== 'string' || !request.body.sdp.startsWith('v=0') || request.body.sdp.length > 128_000) throw new Error('无效的 SDP offer');
      const result = await fetch(new URL('/openai/v1/live/sessions', endpoint), {
        method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: config, transport: { type: 'webrtc', sdp: request.body.sdp } }), signal: AbortSignal.timeout(20_000),
      });
      const data = await result.json() as any;
      if (!result.ok) throw new Error(`Azure ${result.status}: ${data.error?.message ?? '无法创建 WebRTC 会话'}`);
      if (typeof data.session?.id !== 'string' || typeof data.transport?.sdp !== 'string') throw new Error('Azure 返回了不完整的 WebRTC 会话');
      detachedSessionId = data.session.id;
      const attached = await connectUpstream(`/openai/v1/live/sessions/${encodeURIComponent(data.session.id)}/attach`);
      active = bindLive(id, owner.id, config, transport, attached.socket, [{ type: 'session.started', session: data.session }], scene);
      detachedSessionId = undefined;
      if (response.destroyed) closeLive(active, '浏览器已离开');
      response.json({ id, session: data.session, sdp: data.transport.sdp });
    }
  } catch (error) {
    if (active) closeLive(active, '启动失败');
    let cleanupNote = '';
    if (detachedSessionId) {
      try {
        const cleanup = await connectUpstream(`/openai/v1/live/sessions/${encodeURIComponent(detachedSessionId)}/attach`);
        cleanup.socket.on('error', () => {});
        cleanup.socket.send(JSON.stringify({ type: 'session.close', event_id: randomUUID() }));
        const timer = setTimeout(() => cleanup.socket.terminate(), 12_000);
        cleanup.socket.on('close', () => clearTimeout(timer));
        cleanup.socket.on('message', data => { try { if (JSON.parse(data.toString()).type === 'session.closed') cleanup.socket.close(); } catch {} });
        cleanupNote = '；已重连并请求关闭未完成的会话';
      } catch { cleanupNote = '；无法确认远端会话已关闭，请检查 Foundry 会话用量，暂勿反复重试'; }
    }
    response.status(400).json({ error: message(error) + cleanupNote });
  } finally { owner.creating = false; creatingCount--; }
});

function owned(id: string, owner: Owner): Live {
  const live = sessions.get(id);
  if (!live || live.owner !== owner.id) throw new Error('会话不存在或无权访问');
  return live;
}

function submitTool(live: Live, callId: string, output: string) {
  const call = live.tools.calls.get(callId);
  if (!call || call.state !== 'running') throw new Error('工具结果状态无效');
  upstreamSend(live, { type: 'response.item.create', event_id: randomUUID(), item: { type: 'function_call_output', call_id: callId, output } });
  call.state = 'submitted'; call.output = output;
  toolsUpdated(live); continueTools(live);
}

function command(live: Live, raw: unknown, experimental = false) {
  if (live.status !== 'ready') throw new Error('会话正在关闭或已结束，不再接受新命令');
  const event = validateCommand(raw, live.config, live.transport, experimental);
  if (event.type === 'session.update' && live.sceneState) validateSceneConfig(live.sceneState.scene, { ...live.config, ...event.session }, responsesDeployment);
  if (event.delegation_id && !live.delegations.has(event.delegation_id)) throw new Error('delegation_id 不属于当前会话');
  if (event.type === 'response.item.create' && event.item?.type === 'function_call_output') {
    if (live.sceneState) throw new Error('场景工具结果必须在委派任务中批准执行');
    if (typeof event.item.output !== 'string') throw new Error('工具 output 必须是字符串');
    live.tools.claim(event.item.call_id);
    try { submitTool(live, event.item.call_id, event.item.output); }
    catch (error) { live.tools.calls.get(event.item.call_id)!.state = 'pending'; throw error; }
    return;
  }
  if (event.type === 'response.create' && live.tools.hasUnresolved()) throw new Error('先提交所有待处理工具结果');
  if (event.type === 'session.close') { closeLive(live, '用户结束'); return; }
  upstreamSend(live, { ...event, event_id: event.event_id ?? randomUUID() });
}

app.post('/api/sessions/:id/commands', (request, response) => {
  try { command(owned(request.params.id, response.locals.owner), request.body.event, request.body.experimental === true); response.json({ sent: true }); }
  catch (error) { response.status(400).json({ error: message(error) }); }
});

app.post('/api/sessions/:id/tools/:callId', (request, response) => {
  let live: Live | undefined;
  let callId: string | undefined;
  try {
    live = owned(request.params.id, response.locals.owner);
    if (live.status !== 'ready') throw new Error('会话不再接受工具结果');
    if (request.body.approved !== true) throw new Error('执行工具需要显式批准');
    const call = live.tools.claim(request.params.callId); callId = call.callId;
    if (live.sceneState) throw new Error('场景模拟工具由服务器自动执行，无需人工批准');
    const output = request.body.mode === 'manual' ? request.body.output : JSON.stringify(runDemoTool(call.name, JSON.parse(call.arguments)));
    if (typeof output !== 'string' || !output.trim() || output.length > 64_000) throw new Error('工具结果必须是非空文本，最多 64,000 字符');
    submitTool(live, call.callId, output);
    response.json({ sent: true });
  } catch (error) {
    if (live && callId && live.tools.calls.get(callId)?.state === 'running') live.tools.calls.get(callId)!.state = 'pending';
    response.status(400).json({ error: message(error) });
  }
});

app.use('/api', (_request, response) => response.status(404).json({ error: '接口不存在' }));
app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error.status ?? 500).json({ error: message(error) }));
const http = createServer(app);
const clients = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
http.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith('/api/')) return;
  try {
    if (!originAllowed(request.headers.origin, origins)) throw new Error('Origin');
    const ownerId = parseCookie(request.headers.cookie, 'studio_owner');
    const owner = ownerId ? owners.get(ownerId) : undefined;
    if (!owner || owner.expires < Date.now() || owner.principal !== principal(request.headers)) throw new Error('Auth');
    const match = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/events$/);
    if (!match) throw new Error('Path');
    const live = owned(match[1], owner);
    if (live.status === 'closed' || live.clients.size >= 1) throw new Error('Only one browser event connection is allowed');
    clients.handleUpgrade(request, socket, head, client => {
      clearTimeout(live.idle); live.clients.add(client);
      alive.set(client, true);
      client.on('pong', () => alive.set(client, true));
      live.ring.forEach(event => client.send(JSON.stringify(event)));
      client.on('message', (data, binary) => {
        try {
          if (binary) throw new Error('需要 JSON 文本事件');
          command(live, JSON.parse(data.toString()));
        } catch (error) { client.send(JSON.stringify({ type: 'studio.error', message: message(error) })); }
      });
      client.on('error', () => {});
      client.on('close', () => {
        live.clients.delete(client);
        if (!live.clients.size) live.idle = setTimeout(() => closeLive(live, '浏览器断开'), 1000);
      });
    });
  } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); }
});

if (production) {
  app.use(express.static(resolve('dist/client')));
  app.get('/{*path}', (_request, response) => response.sendFile(resolve('dist/client/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa' });
  app.use(vite.middlewares);
}

const sweep = setInterval(() => { for (const [id, owner] of owners) if (owner.expires < Date.now()) owners.delete(id); for (const [id, expires] of loginSessions) if (expires < Date.now()) loginSessions.delete(id); }, 60_000);
sweep.unref();
const heartbeat = setInterval(() => {
  const sockets = [...clients.clients, ...[...sessions.values()].filter(live => live.status !== 'closed').map(live => live.upstream)];
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (alive.get(socket) === false) { socket.terminate(); continue; }
    alive.set(socket, false); socket.ping();
  }
}, 15_000);
heartbeat.unref();
function shutdown() {
  clearInterval(heartbeat); clearInterval(sweep);
  for (const live of sessions.values()) closeLive(live, '服务正在退出');
  http.close();
  setTimeout(() => process.exit(0), 13_000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
http.listen(port, host, () => console.log(`GPT-Live Studio: http://${host}:${port} · key ${configured ? 'configured' : 'missing'}`));
