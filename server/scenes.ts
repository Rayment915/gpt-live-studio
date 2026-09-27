import { object } from '../shared/protocol.js';
import { SCENES, type SceneId } from '../shared/scenarios.js';

export type SceneState = {
  scene: SceneId;
  devices?: { id: string; name: string; power: boolean; brightness?: number; temperature?: number }[];
  agenda?: { time: string; title: string }[];
  notes?: { summary: string; decisions: string[]; actions: string[] }[];
};

export function initialSceneState(scene: SceneId): SceneState {
  if (scene === 'home') return { scene, devices: [
    { id: 'living_light', name: '客厅灯', power: true, brightness: 80 },
    { id: 'air_conditioner', name: '空调', power: false, temperature: 24 },
    { id: 'air_purifier', name: '空气净化器', power: true },
  ] };
  if (scene === 'meeting') return { scene, agenda: [
    { time: '09:30', title: '产品同步会（模拟）' },
    { time: '14:00', title: '样机评审（模拟）' },
  ], notes: [] };
  return { scene };
}

export function sceneToolNames(scene: SceneId): string[] {
  return SCENES[scene].tools.map(tool => tool.type === 'function' ? tool.name : tool.type);
}

export function runSceneTool(state: SceneState, name: string, args: unknown): unknown {
  if (!sceneToolNames(state.scene).includes(name) || !object(args)) throw new Error('此场景不支持该工具或参数');
  if (state.scene === 'home') {
    if (name === 'get_demo_devices') {
      if (Object.keys(args).length) throw new Error('查询设备不接受参数');
      return { simulated: true, devices: state.devices };
    }
    const device = state.devices!.find(item => item.id === args.device_id);
    if (!device || Object.keys(args).some(key => !['device_id', 'power', 'brightness', 'temperature'].includes(key))) throw new Error('设备或参数无效');
    if (!('power' in args || 'brightness' in args || 'temperature' in args)) throw new Error('请指定要更改的状态');
    if ('power' in args && typeof args.power !== 'boolean') throw new Error('power 必须是布尔值');
    if ('brightness' in args && (device.id !== 'living_light' || !Number.isInteger(args.brightness) || args.brightness < 0 || args.brightness > 100)) throw new Error('亮度只能是客厅灯的 0–100 整数');
    if ('temperature' in args && (device.id !== 'air_conditioner' || !Number.isInteger(args.temperature) || args.temperature < 18 || args.temperature > 30)) throw new Error('温度只能是空调的 18–30 整数');
    if ('power' in args) device.power = args.power;
    if ('brightness' in args) device.brightness = args.brightness;
    if ('temperature' in args) device.temperature = args.temperature;
    return { simulated: true, changed: device };
  }
  if (state.scene === 'meeting') {
    if (name === 'get_demo_agenda') {
      if (Object.keys(args).length) throw new Error('查询日程不接受参数');
      return { simulated: true, agenda: state.agenda };
    }
    if (Object.keys(args).some(key => !['summary', 'decisions', 'actions'].includes(key)) || typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 1000) throw new Error('会议摘要必须为 1–1000 字符');
    for (const field of ['decisions', 'actions'] as const) {
      if (!Array.isArray(args[field]) || args[field].length > 10 || !args[field].every((entry: unknown) => typeof entry === 'string' && entry.trim() && entry.length <= 200)) throw new Error(`${field} 最多 10 条，每条最多 200 字符`);
    }
    if (state.notes!.length >= 20) throw new Error('本次会话最多保存 20 条记录');
    const note = { summary: args.summary.trim(), decisions: args.decisions as string[], actions: args.actions as string[] };
    state.notes!.push(note);
    return { simulated: true, saved: note };
  }
  throw new Error('搜索由托管工具执行，不接受本地工具调用');
}

export function evaluateSceneCall(state: SceneState, name: string, argumentsText: string): { state: SceneState; output: string } {
  const nextState = structuredClone(state);
  try {
    const result = runSceneTool(nextState, name, JSON.parse(argumentsText));
    return { state: nextState, output: JSON.stringify(result) };
  } catch (error) {
    return { state, output: JSON.stringify({ simulated: true, ok: false, error: error instanceof Error ? error.message : '工具参数无效', retryable: true }) };
  }
}
