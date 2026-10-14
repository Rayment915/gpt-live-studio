import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/protocol';
import { SCENE_IDS, SCENES, sceneConfig, validateSceneConfig } from '../shared/scenarios';
import { evaluateSceneCall, initialSceneState, runSceneTool } from '../server/scenes';

describe('scenario delegation', () => {
  it('defaults every scene to Luna, default tier and parallel tools while allowing Sol aliases', () => {
    const allowed = ['gpt-6-luna', 'gpt-live-dev-sol'];
    for (const scene of SCENE_IDS) {
      const config = sceneConfig(scene, DEFAULT_CONFIG);
      expect(config.delegation).toMatchObject({ responses: { model: 'gpt-6-luna', service_tier: 'default', parallel_tool_calls: true } });
      expect(() => validateSceneConfig(scene, config, allowed)).not.toThrow();
      expect(() => validateSceneConfig(scene, sceneConfig(scene, DEFAULT_CONFIG, 'gpt-live-dev-sol'), allowed)).not.toThrow();
      expect(() => validateSceneConfig(scene, sceneConfig(scene, DEFAULT_CONFIG, 'not-allowed'), allowed)).toThrow();
    }
    expect(sceneConfig('knowledge', DEFAULT_CONFIG).instructions).toBe('你是企业实时知识库语音助手。客户询问上传资料、产品手册或知识库相关事实时必须先委派查询，收到有依据的结果后再回答。可以简短说明正在查资料。不要凭记忆编造文档内容或来源。允许插话与追问。语气保持温暖、平静和耐心。第一句跟客户说的话是：“你好，我是你的智能客服，有什么可以帮你？”');
  });
  it('offers exactly four scenes pinned to the requested Responses model and tools', () => {
    expect(SCENE_IDS).toEqual(['home', 'meeting', 'search', 'knowledge']);
    for (const scene of SCENE_IDS) {
      const config = sceneConfig(scene, DEFAULT_CONFIG, 'gpt-6.1-sol');
      expect(config.model).toBe('gpt-live-1');
      expect(config.delegation).toEqual({ type: 'responses', responses: { model: 'gpt-6.1-sol', instructions: SCENES[scene].backend, tools: SCENES[scene].tools, tool_choice: 'auto', reasoning: { effort: 'low' }, service_tier: 'default', parallel_tool_calls: true } });
      expect(() => validateSceneConfig(scene, config, 'gpt-6.1-sol')).not.toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'client' } }, 'gpt-6.1-sol')).toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'responses', responses: { model: 'gpt-5.4', tools: SCENES[scene].tools } } }, 'gpt-6.1-sol')).toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'responses', responses: { model: 'gpt-6.1-sol', tools: [] } } }, 'gpt-6.1-sol')).toThrow('工具配置');
    }
    const homeTools = SCENES.home.tools.filter(tool => tool.type === 'function');
    expect(homeTools).toHaveLength(4);
    expect(homeTools.find(tool => tool.name === 'set_demo_air_conditioner')?.parameters.properties).not.toHaveProperty('brightness');
    expect(homeTools.find(tool => tool.name === 'set_demo_light')?.parameters.properties).not.toHaveProperty('temperature');
    expect(homeTools.find(tool => tool.name === 'set_demo_air_purifier')?.parameters.properties).toEqual({ power: { type: 'boolean' } });
  });

  it('changes only simulated device state and rejects cross-device or malformed operations', () => {
    const home = initialSceneState('home');
    const meeting = initialSceneState('meeting');
    expect(runSceneTool(home, 'get_demo_devices', {})).toMatchObject({ simulated: true });
    expect(runSceneTool(home, 'set_demo_light', { brightness: 50 })).toMatchObject({ simulated: true, changed: { brightness: 50 } });
    expect(home.devices?.[0].brightness).toBe(50);
    expect(runSceneTool(home, 'set_demo_air_conditioner', { power: true, temperature: 24 })).toMatchObject({ simulated: true, changed: { id: 'air_conditioner', power: true, temperature: 24 } });
    expect(home.devices?.[1]).toMatchObject({ power: true, temperature: 24 });
    expect(runSceneTool(home, 'set_demo_air_purifier', { power: false })).toMatchObject({ simulated: true, changed: { id: 'air_purifier', power: false } });
    expect(initialSceneState('home').devices?.[0].brightness).toBe(80);
    expect(() => runSceneTool(home, 'set_demo_light', { temperature: 25 })).toThrow();
    expect(() => runSceneTool(home, 'set_demo_air_conditioner', { temperature: 100 })).toThrow();
    expect(() => runSceneTool(home, 'set_demo_air_conditioner', { power: true, brightness: 0, temperature: 24 })).toThrow('亮度只能是客厅灯');
    expect(() => runSceneTool(home, 'set_demo_light', { power: true, authorization: 'x' })).toThrow();
    expect(() => runSceneTool(meeting, 'set_demo_air_conditioner', { power: true })).toThrow();
  });

  it('bounds meeting notes and never performs a search through local demo tools', () => {
    const meeting = initialSceneState('meeting');
    expect(runSceneTool(meeting, 'get_demo_agenda', {})).toMatchObject({ simulated: true });
    expect(runSceneTool(meeting, 'save_demo_meeting_note', { summary: '样机周五交付', decisions: ['周五交付'], actions: ['准备样机'] })).toMatchObject({ simulated: true });
    expect(meeting.notes).toHaveLength(1);
    expect(() => runSceneTool(meeting, 'save_demo_meeting_note', { summary: 'note', decisions: [], actions: ['x'.repeat(201)] })).toThrow();
    expect(() => runSceneTool(initialSceneState('search'), 'web_search', {})).toThrow('托管');
  });

  it('returns recoverable tool errors without mutating state, then accepts a corrected call', () => {
    const home = initialSceneState('home');
    const invalid = evaluateSceneCall(home, 'set_demo_light', '{"power":false,"brightness":80,"temperature":24}');
    expect(invalid.state).toBe(home);
    expect(JSON.parse(invalid.output)).toMatchObject({ ok: false, retryable: true, error: '温度只能是空调的 18–30 整数' });
    expect(home.devices?.[0].power).toBe(true);
    const corrected = evaluateSceneCall(invalid.state, 'set_demo_light', '{"power":false}');
    expect(JSON.parse(corrected.output)).toMatchObject({ simulated: true, changed: { power: false } });
    expect(corrected.state.devices?.[0].power).toBe(false);
    expect(home.devices?.[0].power).toBe(true);
    expect(JSON.parse(evaluateSceneCall(home, 'set_demo_light', '{bad').output).ok).toBe(false);
    expect(JSON.parse(evaluateSceneCall(home, 'unknown_tool', '{}').output).ok).toBe(false);
  });
});
