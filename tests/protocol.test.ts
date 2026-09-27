import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, safeEvent, validateCommand, validateConfig } from '../shared/protocol';

describe('GPT-Live configuration', () => {
  it('round trips strict startup fields without inventing Realtime options', () => {
    expect(validateConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(() => validateConfig({ ...DEFAULT_CONFIG, temperature: 0.8 })).toThrow('temperature');
    expect(() => validateConfig({ ...DEFAULT_CONFIG, audio: { input: { sample_rate: 16000 } } })).toThrow('input');
  });
  it('rejects malformed nested fields and secret-bearing configs', () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, model: '' })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, audio: { output: { voice: 42 } } })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, delegation: { type: 'responses', responses: { model: 'gpt-5.4', api_key: 'secret' } } })).toThrow('密钥');
  });
  it('allows hosted tools and retains extended Responses configuration', () => {
    const config = { ...DEFAULT_CONFIG, delegation: { type: 'responses', responses: { model: 'gpt-5.4', tools: [{ type: 'web_search' }], reasoning: { effort: 'medium' }, metadata: { project: 'studio' } } } };
    expect(validateConfig(config)).toEqual(config);
  });
  it('prevents changes to startup fields and switching delegation modes', () => {
    expect(() => validateCommand({ type: 'session.update', session: { instructions: 'new' } }, DEFAULT_CONFIG, 'webrtc')).toThrow('instructions');
    expect(() => validateCommand({ type: 'session.update', session: { delegation: { type: 'responses', responses: { model: 'gpt-5.4' } } } }, DEFAULT_CONFIG, 'webrtc')).toThrow('重新开始');
  });
  it('requires complete Responses delegation for updates', () => {
    const config = validateConfig({ ...DEFAULT_CONFIG, delegation: { type: 'responses', responses: { model: 'gpt-5.4' } } });
    expect(() => validateCommand({ type: 'session.update', session: { delegation: { type: 'responses', responses: { tools: [] } } } }, config, 'websocket')).toThrow('model');
    expect(validateCommand({ type: 'session.update', session: { delegation: config.delegation } }, config, 'websocket').type).toBe('session.update');
  });
});

describe('events and transports', () => {
  it('rejects WebRTC JSON audio, bad base64 and odd PCM', () => {
    expect(() => validateCommand({ type: 'session.input_audio.append', audio: 'AAA=' }, DEFAULT_CONFIG, 'webrtc')).toThrow('WebRTC');
    for (const audio of ['', '*', 'AA==']) expect(() => validateCommand({ type: 'session.input_audio.append', audio }, DEFAULT_CONFIG, 'websocket')).toThrow();
    expect(validateCommand({ type: 'session.input_audio.append', audio: 'AAA=' }, DEFAULT_CONFIG, 'websocket')).toBeTruthy();
  });
  it('requires context correlation, allows null for general context', () => {
    expect(() => validateCommand({ type: 'session.thinking.append', content: 'hello' }, DEFAULT_CONFIG, 'webrtc')).toThrow('delegation_id');
    expect(validateCommand({ type: 'session.thinking.append', content: 'hello', delegation_id: null }, DEFAULT_CONFIG, 'webrtc')).toBeTruthy();
  });
  it('experimental events never bypass transport or secret rules', () => {
    expect(() => validateCommand({ type: 'future.event' }, DEFAULT_CONFIG, 'webrtc')).toThrow();
    expect(validateCommand({ type: 'future.event' }, DEFAULT_CONFIG, 'webrtc', true).type).toBe('future.event');
    expect(() => validateCommand({ type: 'future.event', authorization: 'secret' }, DEFAULT_CONFIG, 'webrtc', true)).toThrow();
    expect(() => validateCommand({ type: 'session.start' }, DEFAULT_CONFIG, 'webrtc', true)).toThrow();
  });
  it('redacts secrets and audio but not transcript delta', () => {
    expect(safeEvent({ type: 'error', message: 'key-value', nested: { api_key: 'hidden' } }, 'key-value')).toEqual({ type: 'error', message: '[redacted]', nested: { api_key: '[redacted]' } });
    expect(safeEvent({ type: 'session.output_audio.delta', delta: 'AAA=' }).delta).toContain('audio:');
    expect(safeEvent({ type: 'session.input_transcript.delta', delta: '你好' }).delta).toBe('你好');
  });
});
