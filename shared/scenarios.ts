import { object, type SessionConfig } from './protocol';

export const SCENE_IDS = ['home', 'meeting', 'search'] as const;
export type SceneId = typeof SCENE_IDS[number];

export const SCENES = {
  home: {
    title: '智能家居', example: '“把客厅灯调到一半亮度，再告诉我空调状态。”',
    notice: '设备和状态均为模拟；服务器校验后自动执行，不会控制真实家电。',
    instructions: '你是实时智能家居语音助手。家电全部为模拟设备。可以边倾听边回应，但只有工具结果确认后才能说操作已经完成；永远明确说明这是模拟操作。',
    backend: '查询模拟设备状态，按用户意图调用已列出的工具。不要声称控制了真实家电。仅向对应设备传递适用字段：亮度只用于客厅灯，温度只用于空调。工具返回错误时修正参数重试；仅在收到成功结果后声称已完成。',
    tools: [
      { type: 'function', name: 'get_demo_devices', description: '查看当前会话内的模拟家电状态。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { type: 'function', name: 'set_demo_device', description: '调整模拟家电；仅传需要修改的字段。brightness 只适用于 living_light，temperature 只适用于 air_conditioner；服务端自动校验执行。', parameters: { type: 'object', properties: { device_id: { type: 'string', enum: ['living_light', 'air_conditioner', 'air_purifier'] }, power: { type: 'boolean' }, brightness: { type: 'integer', minimum: 0, maximum: 100 }, temperature: { type: 'integer', minimum: 18, maximum: 30 } }, required: ['device_id'], additionalProperties: false } },
    ],
  },
  meeting: {
    title: '会议副驾', example: '“查一下今天日程，帮我记下样机周五交付这个决定。”',
    notice: '日程和会议记录均为模拟；不会发送邮件或创建真实会议。',
    instructions: '你是实时会议副驾。边听边帮助提炼决定和待办，必要时查询模拟日程或请求保存模拟会议记录。未经工具确认不要声称记录已保存，始终说明这是演示数据。',
    backend: '结合当前讨论总结决定与待办。日程与会议记录都是模拟数据，由服务器校验后自动保存；工具返回错误时修正参数重试。不得声称发送邮件、创建真实会议或修改真实日程。',
    tools: [
      { type: 'function', name: 'get_demo_agenda', description: '读取当前会话内的模拟日程。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { type: 'function', name: 'save_demo_meeting_note', description: '保存会话内的模拟会议记录，由服务器校验后自动执行。', parameters: { type: 'object', properties: { summary: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } }, actions: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'decisions', 'actions'], additionalProperties: false } },
    ],
  },
  search: {
    title: '边聊边搜', example: '“查一下最新进展，给出能核对的来源，我可以随时追问。”',
    notice: '真实网页搜索可能产生额外费用；未返回来源时不会编造引用。',
    instructions: '你是实时信息检索搭档。需要新信息时委派网页搜索，边聊边接收追问；只陈述得到的结果，未知就说明未知，不得编造来源。',
    backend: '需要最新事实时使用 web_search。优先清楚引用工具确实返回的来源；没有可核验来源时明确告知用户。',
    tools: [{ type: 'web_search' }],
  },
} as const;

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === 'string' && SCENE_IDS.some(scene => scene === value);
}

export function sceneConfig(scene: SceneId, base: SessionConfig, responsesModel: string): SessionConfig {
  const definition = SCENES[scene];
  return {
    model: base.model,
    instructions: definition.instructions,
    audio: base.audio,
    delegation: { type: 'responses', responses: { model: responsesModel, instructions: definition.backend, tools: structuredClone(definition.tools), tool_choice: 'auto' } },
  };
}

export function validateSceneConfig(scene: SceneId, config: SessionConfig, responsesModel: string): void {
  const delegation = config.delegation;
  if (!delegation || delegation.type !== 'responses' || !object(delegation.responses) || delegation.responses.model !== responsesModel) throw new Error('此场景必须使用服务器配置的 Responses 委派部署');
  const expected = SCENES[scene].tools;
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
  if (!Array.isArray(delegation.responses.tools) || canonical(delegation.responses.tools) !== canonical(expected)) throw new Error('此场景的工具配置不可更改；请重新选择场景');
}
