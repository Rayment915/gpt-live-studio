import { describe, expect, it } from 'vitest';
import { emptyState, groupTranscripts, reduceEvent } from '../src/lib/state';
import { ToolLedger, runDemoTool } from '../server/tools';
import { evaluateSceneCall, initialSceneState } from '../server/scenes';

describe('session state', () => {
  it('takes the latest cumulative usage instead of summing it', () => {
    let state = reduceEvent(emptyState(), { type: 'session.usage.updated', usage: { seconds: 12 }, context_window: { usage_ratio: 0.2 } });
    state = reduceEvent(state, { type: 'session.usage.updated', usage: { seconds: 20 } });
    expect(state.seconds).toBe(20); expect(state.finalUsage).toBe(false);
    state = reduceEvent(state, { type: 'session.closed', usage: { seconds: 25 } });
    expect(state.seconds).toBe(25); expect(state.finalUsage).toBe(true);
  });
  it('preserves interleaved speaker fragments and unknown events', () => {
    let state = reduceEvent(emptyState(), { type: 'session.input_transcript.delta', delta: '你', start_ms: 0, end_ms: 100 });
    state = reduceEvent(state, { type: 'session.output_transcript.delta', delta: '好', start_ms: 20, end_ms: 90 });
    state = reduceEvent(state, { type: 'new.event', value: 1 });
    expect(state.transcripts.map(item => item.speaker)).toEqual(['input', 'output']);
    expect(state.events.at(-1)?.event.value).toBe(1);
  });
  it('retains only HTTPS citations returned by the response, without inventing sources', () => {
    let state = reduceEvent(emptyState(), { type: 'session.delegation.created', delegation: { id: 'task', target: 'responses' }, offset_ms: 0 });
    state = reduceEvent(state, { type: 'response.event', delegation_id: 'task', event: { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', annotations: [{ type: 'url_citation', title: '官方页面', url: 'https://example.com/fact' }, { type: 'url_citation', url: 'javascript:alert(1)' }] }] }] } } });
    expect(state.delegations[0].sources).toEqual([{ title: '官方页面', url: 'https://example.com/fact' }]);
    state = reduceEvent(state, { type: 'response.event', delegation_id: 'task', event: { type: 'response.output_text.delta', delta: '还有一个来源 https://invented.invalid' } });
    expect(state.delegations[0].sources).toHaveLength(1);
  });
  it('groups word deltas into sentences without mixing simultaneous speakers', () => {
    const fragments = [
      { speaker: 'input' as const, text: 'Hello', start: 0, end: 100 },
      { speaker: 'output' as const, text: '你', start: 10, end: 100 },
      { speaker: 'input' as const, text: ' world.', start: 100, end: 200 },
      { speaker: 'output' as const, text: '好。', start: 100, end: 200 },
      { speaker: 'input' as const, text: ' Next sentence!', start: 200, end: 350 },
    ];
    expect(groupTranscripts(fragments).map(item => [item.speaker, item.text])).toEqual([
      ['input', 'Hello world.'], ['output', '你好。'], ['input', ' Next sentence!'],
    ]);
    expect(fragments[0].text).toBe('Hello');
  });
  it('starts a new subtitle after a pause even without punctuation', () => {
    expect(groupTranscripts([
      { speaker: 'input', text: 'First', start: 0, end: 100 },
      { speaker: 'input', text: 'Second', start: 2000, end: 2100 },
    ]).map(item => item.text)).toEqual(['First', 'Second']);
  });
  it('does not sum duplicate backend usage and retains delegation identity', () => {
    let state = reduceEvent(emptyState(), { type: 'session.delegation.created', delegation: { id: 'delegated', target: 'responses' }, offset_ms: 0 });
    const event = { type: 'response.event', delegation_id: 'delegated', event: { type: 'response.completed', response: { id: 'response-1', usage: { total_tokens: 30 } } } };
    state = reduceEvent(reduceEvent(state, event), event);
    expect(Object.keys(state.backendUsage)).toEqual(['response-1']);
    expect(state.delegations[0].status).toBe('后端响应完成');
  });
  it('shows tool processing and continuation instead of declaring the delegation done', () => {
    let state = reduceEvent(emptyState(), { type: 'session.delegation.created', delegation: { id: 'delegated', target: 'responses' }, offset_ms: 0 });
    state = reduceEvent(state, { type: 'response.event', delegation_id: 'delegated', event: { type: 'response.completed', response: { output: [{ type: 'function_call' }] } } });
    expect(state.delegations[0].status).toBe('处理工具中');
    state = reduceEvent(state, { type: 'studio.tools', calls: [{ callId: 'call-1', delegationId: 'delegated', state: 'pending' }] });
    expect(state.delegations[0].status).toBe('处理工具中');
    state = reduceEvent(state, { type: 'studio.response.continued', batch_id: 'delegated:initial' });
    expect(state.delegations[0].status).toBe('后端继续处理中');
    state = reduceEvent(state, { type: 'response.event', delegation_id: 'delegated', event: { type: 'response.in_progress' } });
    expect(state.delegations[0].status).toBe('进行中');
  });
});

describe('parallel tool ledger', () => {
  const envelope = (event: any) => ({ type: 'response.event', delegation_id: 'delegation-1', event });
  const callEvent = (callId: string) => envelope({ type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name: 'get_current_time', arguments: '{"timezone":"Asia/Shanghai"}' } });
  it('deduplicates calls and continues only after sealed batch and all results', () => {
    const ledger = new ToolLedger();
    ledger.ingest(callEvent('first')); ledger.ingest(callEvent('first')); ledger.ingest(callEvent('second'));
    expect(ledger.calls.size).toBe(2);
    ledger.claim('first').state = 'submitted';
    expect(() => ledger.claim('first')).toThrow();
    ledger.claim('second').state = 'submitted';
    expect(ledger.readyBatches()).toEqual([]);
    ledger.ingest(envelope({ type: 'response.completed' }));
    expect(ledger.readyBatches()).toHaveLength(1);
    ledger.batches.get(ledger.readyBatches()[0])!.continued = true;
    expect(ledger.readyBatches()).toEqual([]);
  });
  it('can continue a completed batch after a rejected simulated operation', () => {
    const ledger = new ToolLedger();
    ledger.ingest(envelope({ type: 'response.created', response: { id: 'response-1' } }));
    ledger.ingest(envelope({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'invalid', name: 'set_demo_light', arguments: '{"temperature":24}' } }));
    const call = ledger.claim('invalid');
    const result = evaluateSceneCall(initialSceneState('home'), call.name, call.arguments);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, retryable: true });
    call.output = result.output;
    call.state = 'submitted';
    ledger.ingest(envelope({ type: 'response.completed' }));
    expect(ledger.readyBatches()).toEqual(['delegation-1:response-1']);
    ledger.batches.get('delegation-1:response-1')!.continued = true;
    expect(ledger.readyBatches()).toEqual([]);
  });
  it('does not run unknown functions or interpret arguments as code', () => {
    expect(() => runDemoTool('exec', { command: 'echo nope' })).toThrow('未注册');
    expect(() => runDemoTool('get_current_time', { timezone: 'invalid/timezone' })).toThrow();
    expect(runDemoTool('lookup_demo_product', { sku: 'STUDIO-01' })).toMatchObject({ simulated: true });
  });
  it('supports multiple tool cycles without requiring another response.created', () => {
    const ledger = new ToolLedger();
    ledger.ingest(callEvent('first'));
    ledger.claim('first').state = 'submitted';
    ledger.ingest(envelope({ type: 'response.completed' }));
    const firstBatch = ledger.readyBatches()[0];
    ledger.batches.get(firstBatch)!.continued = true;
    ledger.ingest(envelope({ type: 'response.in_progress' }));
    ledger.ingest(callEvent('second'));
    ledger.claim('second').state = 'submitted';
    expect(ledger.readyBatches()).toHaveLength(0);
    ledger.ingest(envelope({ type: 'response.completed' }));
    expect(ledger.readyBatches()).toHaveLength(1);
    expect(ledger.readyBatches()[0]).not.toBe(firstBatch);
  });
});
