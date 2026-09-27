import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/protocol';
import { SCENE_IDS, SCENES, sceneConfig, validateSceneConfig } from '../shared/scenarios';
import { evaluateSceneCall, initialSceneState, runSceneTool } from '../server/scenes';

describe('scenario delegation', () => {
  it('offers exactly three scenes pinned to the requested Responses model and tools', () => {
    expect(SCENE_IDS).toEqual(['home', 'meeting', 'search']);
    for (const scene of SCENE_IDS) {
      const config = sceneConfig(scene, DEFAULT_CONFIG, 'gpt-6-luna');
      expect(config.model).toBe('gpt-live-1');
      expect(config.delegation).toEqual({ type: 'responses', responses: { model: 'gpt-6-luna', instructions: SCENES[scene].backend, tools: SCENES[scene].tools, tool_choice: 'auto' } });
      expect(() => validateSceneConfig(scene, config, 'gpt-6-luna')).not.toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'client' } }, 'gpt-6-luna')).toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'responses', responses: { model: 'gpt-5.4', tools: SCENES[scene].tools } } }, 'gpt-6-luna')).toThrow();
      expect(() => validateSceneConfig(scene, { ...config, delegation: { type: 'responses', responses: { model: 'gpt-6-luna', tools: [] } } }, 'gpt-6-luna')).toThrow('工具配置');
    }
  });

  it('changes only simulated device state and rejects cross-device or malformed operations', () => {
    const home = initialSceneState('home');
    const meeting = initialSceneState('meeting');
    expect(runSceneTool(home, 'get_demo_devices', {})).toMatchObject({ simulated: true });
    expect(runSceneTool(home, 'set_demo_device', { device_id: 'living_light', brightness: 50 })).toMatchObject({ simulated: true, changed: { brightness: 50 } });
    expect(home.devices?.[0].brightness).toBe(50);
    expect(initialSceneState('home').devices?.[0].brightness).toBe(80);
    expect(() => runSceneTool(home, 'set_demo_device', { device_id: 'living_light', temperature: 25 })).toThrow();
    expect(() => runSceneTool(home, 'set_demo_device', { device_id: 'air_conditioner', temperature: 100 })).toThrow();
    expect(() => runSceneTool(home, 'set_demo_device', { device_id: 'living_light', power: true, authorization: 'x' })).toThrow();
    expect(() => runSceneTool(meeting, 'set_demo_device', { device_id: 'living_light', power: true })).toThrow();
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
    const invalid = evaluateSceneCall(home, 'set_demo_device', '{"device_id":"living_light","power":false,"brightness":80,"temperature":24}');
    expect(invalid.state).toBe(home);
    expect(JSON.parse(invalid.output)).toMatchObject({ ok: false, retryable: true, error: '温度只能是空调的 18–30 整数' });
    expect(home.devices?.[0].power).toBe(true);
    const corrected = evaluateSceneCall(invalid.state, 'set_demo_device', '{"device_id":"living_light","power":false}');
    expect(JSON.parse(corrected.output)).toMatchObject({ simulated: true, changed: { power: false } });
    expect(corrected.state.devices?.[0].power).toBe(false);
    expect(home.devices?.[0].power).toBe(true);
    expect(JSON.parse(evaluateSceneCall(home, 'set_demo_device', '{bad').output).ok).toBe(false);
    expect(JSON.parse(evaluateSceneCall(home, 'unknown_tool', '{}').output).ok).toBe(false);
  });
});
