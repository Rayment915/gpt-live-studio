import { safeEvent, type Event } from '../../shared/protocol';
import type { ToolCall } from '../../server/tools';
import type { SceneState } from '../../server/scenes';

export type Transcript = { speaker: 'input' | 'output'; text: string; start: number; end: number };
export type Delegation = { id: string; target: string; offset: number; status: string; text: string; sources: { title: string; url: string }[] };
export type StudioState = {
  events: { direction: 'in' | 'out'; time: number; event: Event }[];
  transcripts: Transcript[];
  delegations: Delegation[];
  tools: ToolCall[];
  sceneState?: SceneState;
  seconds: number;
  contextRatio: number;
  finalUsage: boolean;
  backendUsage: Record<string, any>;
  inputMuted: boolean;
};
export const emptyState = (): StudioState => ({ events: [], transcripts: [], delegations: [], tools: [], seconds: 0, contextRatio: 0, finalUsage: false, backendUsage: {}, inputMuted: false });

function responseSources(event: Event): { title: string; url: string }[] {
  const annotations = event.type === 'response.output_text.annotation.added' ? [event.annotation] :
    event.type === 'response.completed' ? (event.response?.output ?? []).flatMap((item: any) => (item.content ?? []).flatMap((content: any) => content.annotations ?? [])) : [];
  return annotations.filter((item: any) => item?.type === 'url_citation' && typeof item.url === 'string' && /^https:\/\//i.test(item.url) && URL.canParse(item.url)).slice(0, 20).map((item: any) => ({ title: typeof item.title === 'string' ? item.title.slice(0, 120) : new URL(item.url).hostname, url: item.url }));
}

export function groupTranscripts(fragments: Transcript[]): Transcript[] {
  const sentences: Transcript[] = [];
  const active: Partial<Record<Transcript['speaker'], number>> = {};
  for (const fragment of fragments) {
    if (!fragment.text) continue;
    const index = active[fragment.speaker];
    const previous = index === undefined ? undefined : sentences[index];
    if (previous && !/[。！？.!?…]["'”’）)]?\s*$/u.test(previous.text) && fragment.start - previous.end < 1500 && previous.text.length < 300) {
      previous.text += fragment.text;
      previous.end = Math.max(previous.end, fragment.end);
    } else {
      active[fragment.speaker] = sentences.push({ ...fragment }) - 1;
    }
  }
  return sentences;
}

export function reduceEvent(state: StudioState, event: Event, direction: 'in' | 'out' = 'in'): StudioState {
  const next = { ...state, events: [...state.events, { direction, time: Date.now(), event: safeEvent(event) }].slice(-800) };
  if (direction === 'out') return next;
  if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
    const speaker: Transcript['speaker'] = event.type === 'session.input_transcript.delta' ? 'input' : 'output';
    next.transcripts = [...state.transcripts, { speaker, text: event.delta, start: event.start_ms, end: event.end_ms } as Transcript].slice(-3000);
  }
  if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
    next.seconds = event.usage?.seconds ?? next.seconds;
    next.contextRatio = event.context_window?.usage_ratio ?? next.contextRatio;
    if (event.type === 'session.closed') next.finalUsage = true;
  }
  if (event.type === 'session.input_audio.muted') next.inputMuted = true;
  if (event.type === 'session.input_audio.unmuted') next.inputMuted = false;
  if (event.type === 'studio.tools') {
    next.tools = event.calls;
    next.delegations = state.delegations.map(item => {
      const calls = event.calls.filter((call: ToolCall) => call.delegationId === item.id);
      return calls.some((call: ToolCall) => call.state !== 'submitted') ? { ...item, status: '处理工具中' } : item;
    });
  }
  if (event.type === 'studio.response.continued') {
    const delegationId = typeof event.batch_id === 'string' ? event.batch_id.split(':')[0] : '';
    next.delegations = state.delegations.map(item => item.id === delegationId ? { ...item, status: '后端继续处理中' } : item);
  }
  if (event.type === 'studio.scene.state') next.sceneState = event.state;
  if (event.type === 'session.delegation.created') {
    const delegation = event.delegation;
    if (!state.delegations.some(item => item.id === delegation.id)) next.delegations = [...state.delegations, { id: delegation.id, target: delegation.target, offset: event.offset_ms, status: '进行中', text: '', sources: [] }];
  }
  if (event.type === 'response.event') {
    const nested = event.event;
    next.delegations = state.delegations.map(item => item.id !== event.delegation_id ? item : { ...item, text: item.text + (nested.type === 'response.output_text.delta' ? nested.delta : ''), sources: [...new Map([...item.sources, ...responseSources(nested)].map(source => [source.url, source])).values()].slice(0, 20), status: nested.type === 'response.completed' ? (nested.response?.output?.some((output: any) => output.type === 'function_call') || state.tools.some(call => call.delegationId === item.id && call.state !== 'submitted') ? '处理工具中' : '后端响应完成') : ['response.failed', 'response.incomplete'].includes(nested.type) ? '响应未完成' : ['response.created', 'response.in_progress'].includes(nested.type) ? '进行中' : item.status });
    if (nested.type === 'response.completed' && nested.response?.usage) next.backendUsage = { ...state.backendUsage, [nested.response.id ?? event.delegation_id]: nested.response.usage };
  }
  return next;
}
