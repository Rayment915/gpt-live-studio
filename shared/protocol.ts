export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Event = { type: string; [key: string]: any };
export type Transport = 'webrtc' | 'websocket';
export interface SessionConfig {
  model: string;
  instructions?: string;
  audio?: { output?: { voice?: string } };
  delegation?: { type: 'client' } | { type: 'responses'; responses: Record<string, any> } | null;
}

// Built-in enum from the GPT-Live session API (verified 2026-10-14).
// https://developers.openai.com/api/reference/resources/live/methods/create
export const DOCUMENTED_LIVE_VOICES = ['alloy', 'ash', 'ballad', 'beacon', 'bossa', 'brise', 'cedar', 'cinder', 'coral', 'delta', 'echo', 'flitz', 'gleam', 'harema', 'juni', 'marin', 'meridian', 'nira', 'noeul', 'nuri', 'quartz', 'ripple', 'sage', 'shida', 'shimmer', 'sillage', 'stone', 'tempo', 'verse', 'vesper', 'willow'] as const;
// User-selected UI options, all verified on Azure gpt-live-1 on 2026-10-14.
export const LIVE_VOICES = ['marin', 'quartz', 'vesper', 'willow', 'gleam', 'meridian'] as const;
export const DEFAULT_LIVE_PROMPT = '你是企业实时知识库语音助手。客户询问上传资料、产品手册或知识库相关事实时必须先委派查询，收到有依据的结果后再回答。可以简短说明正在查资料。不要凭记忆编造文档内容或来源。允许插话与追问。语气保持温暖、平静和耐心';
export const DEFAULT_RESPONSES_MODEL = 'gpt-6-luna';

export const DEFAULT_CONFIG: SessionConfig = {
  model: 'gpt-live-1',
  instructions: DEFAULT_LIVE_PROMPT,
  audio: { output: { voice: 'marin' } },
  delegation: { type: 'client' },
};

export const DEMO_TOOLS = [
  { type: 'function', name: 'get_current_time', description: '获取指定 IANA 时区的当前时间。', parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'], additionalProperties: false } },
  { type: 'function', name: 'lookup_demo_product', description: '查询固定演示商品目录，数据为模拟，不可下单。', parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } },
];

export function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const extra = Object.keys(value).filter(key => !keys.includes(key));
  if (extra.length) throw new Error(`${label} 不支持字段：${extra.join(', ')}`);
}

export function rejectSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(api[-_]?key|authorization|access_token|client_secret|password|headers)$/i.test(key)) throw new Error('配置或事件中不可包含密钥、鉴权头或密码');
    rejectSecrets(item);
  }
}

export function validateConfig(value: unknown): SessionConfig {
  if (!object(value)) throw new Error('会话配置必须是 JSON 对象');
  rejectSecrets(value);
  onlyKeys(value, ['model', 'instructions', 'audio', 'delegation'], 'session');
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('model 必须是非空部署名');
  if (value.instructions !== undefined && typeof value.instructions !== 'string') throw new Error('instructions 必须是文本');
  if (value.audio !== undefined) {
    if (!object(value.audio)) throw new Error('audio 必须是对象');
    onlyKeys(value.audio, ['output'], 'audio');
    if (value.audio.output !== undefined) {
      if (!object(value.audio.output)) throw new Error('audio.output 必须是对象');
      onlyKeys(value.audio.output, ['voice'], 'audio.output');
      if (value.audio.output.voice !== undefined && (typeof value.audio.output.voice !== 'string' || !value.audio.output.voice.trim())) throw new Error('voice 必须是非空文本');
    }
  }
  if (value.delegation != null) {
    const delegation = value.delegation;
    if (!object(delegation) || !['client', 'responses'].includes(delegation.type)) throw new Error('delegation.type 必须是 client 或 responses');
    onlyKeys(delegation, delegation.type === 'client' ? ['type'] : ['type', 'responses'], 'delegation');
    if (delegation.type === 'responses') {
      if (!object(delegation.responses) || typeof delegation.responses.model !== 'string' || !delegation.responses.model.trim()) throw new Error('Responses 委派需要 model 部署名');
      const settings = delegation.responses;
      if (settings.parallel_tool_calls !== undefined && typeof settings.parallel_tool_calls !== 'boolean') throw new Error('parallel_tool_calls 必须是布尔值');
      if (settings.service_tier !== undefined && !['auto', 'default', 'flex', 'priority'].includes(settings.service_tier)) throw new Error('service_tier 无效');
      if (settings.max_output_tokens !== undefined && (!Number.isInteger(settings.max_output_tokens) || settings.max_output_tokens < 1)) throw new Error('max_output_tokens 必须是正整数');
      if (settings.tools !== undefined && (!Array.isArray(settings.tools) || !settings.tools.every((tool: unknown) => object(tool) && typeof tool.type === 'string'))) throw new Error('tools 必须是工具对象数组');
    }
  }
  return structuredClone(value) as SessionConfig;
}

export const CLIENT_EVENTS = ['session.update', 'session.input_audio.append', 'session.input_audio.mute', 'session.input_audio.unmute', 'session.instructions.append', 'session.thinking.append', 'session.commentary.append', 'response.item.create', 'response.create', 'session.close'];

export function validateCommand(event: unknown, config: SessionConfig, transport: Transport, experimental = false): Event {
  if (!object(event) || typeof event.type !== 'string') throw new Error('事件需要 type');
  rejectSecrets(event);
  if (event.type === 'session.start') throw new Error('会话已创建，不能重复 session.start');
  if (!experimental && !CLIENT_EVENTS.includes(event.type)) throw new Error('未知事件；如需验证新协议，请启用实验性发送');
  if (event.type === 'session.update') {
    if (!object(event.session)) throw new Error('session.update 需要 session 对象');
    onlyKeys(event.session, ['delegation'], 'session.update.session');
    if ('delegation' in event.session) {
      if (config.delegation?.type !== 'responses' || event.session.delegation?.type !== 'responses') throw new Error('切换委派模式需重新开始会话');
      validateConfig({ ...config, delegation: event.session.delegation });
    }
  }
  if (event.type === 'session.input_audio.append') {
    if (transport !== 'websocket') throw new Error('WebRTC 使用媒体轨道，不接受 JSON 音频');
    if (typeof event.audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.audio) || !event.audio.length) throw new Error('音频必须是非空 base64 PCM');
    const bytes = event.audio.length * 3 / 4 - (event.audio.endsWith('==') ? 2 : event.audio.endsWith('=') ? 1 : 0);
    if (bytes % 2) throw new Error('PCM16 音频字节数必须为偶数');
  }
  if (/^session\.(instructions|thinking|commentary)\.append$/.test(event.type)) {
    if (typeof event.content !== 'string' || !event.content.trim()) throw new Error('content 不能为空');
    if (!('delegation_id' in event) || !(event.delegation_id === null || typeof event.delegation_id === 'string')) throw new Error('delegation_id 必须是任务 ID 或 null');
  }
  if (event.type.startsWith('response.') && config.delegation?.type !== 'responses') throw new Error('此事件需要 Responses 委派模式');
  return event as Event;
}

export function safeEvent(event: Event, secret = ''): Event {
  const serialized = JSON.stringify(event, (key, value) => {
    if (/^(api[-_]?key|authorization|access_token|client_secret|password|headers)$/i.test(key)) return '[redacted]';
    if ((key === 'audio' && typeof value === 'string') || (key === 'delta' && event.type === 'session.output_audio.delta')) return `[audio: ${value.length} base64 chars]`;
    return value;
  });
  return JSON.parse(secret ? serialized.split(secret).join('[redacted]') : serialized);
}
