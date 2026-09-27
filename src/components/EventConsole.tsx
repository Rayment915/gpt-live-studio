import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Braces, ChevronDown, Search, Send, Terminal } from 'lucide-react';
import type { Event } from '../../shared/protocol';
import type { StudioState } from '../lib/state';

const templates: Record<string, Event> = {
  '补充上下文': { type: 'session.thinking.append', delegation_id: null, content: '用户希望使用中文交流。' },
  '追加指令': { type: 'session.instructions.append', delegation_id: null, content: '请更简洁地回答。' },
  '请模型说出': { type: 'session.commentary.append', delegation_id: null, content: '欢迎来到 GPT-Live Studio。' },
  'Responses 用户消息': { type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请查询上海当前时间。' }] } },
  '继续 Responses': { type: 'response.create' },
};

export function EventConsole({ state, active, send }: { state: StudioState; active: boolean; send: (event: Event, experimental: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [raw, setRaw] = useState(JSON.stringify(templates['补充上下文'], null, 2));
  const [experimental, setExperimental] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className={`event-console panel ${open ? 'expanded' : ''}`} aria-label="事件控制台">
    <button className="console-toggle" onClick={() => setOpen(!open)} aria-expanded={open}><span><Terminal size={16} /><strong>事件控制台</strong><span className="console-subtitle">完整协议，透明可见</span></span><span><span className="count">{state.events.length}</span><ChevronDown className={open ? 'rotated' : ''} size={16} /></span></button>
    {open && <div className="console-content"><div className="events-list"><label className="search-field"><Search size={15} /><input aria-label="过滤事件" placeholder="按事件名过滤…" value={filter} onChange={event => setFilter(event.target.value)} /></label><div className="event-scroll">
      {!state.events.length && <div className="console-empty"><Braces size={24} /><p>连接后显示真实事件，不填充模拟数据。</p></div>}
      {state.events.filter(entry => entry.event.type.includes(filter)).map((entry, index) => <details className="event-row" key={`${entry.time}-${index}`}><summary>{entry.direction === 'in' ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}<time>{new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><code>{entry.event.type}</code></summary><pre>{JSON.stringify(entry.event, null, 2)}</pre></details>)}
    </div><p className="field-help">仅保留最近 800 个事件；音频载荷已省略。未知事件仍会保留。</p></div>
      <div className="event-composer"><div className="field"><label htmlFor="event-template">发送协议事件</label><select id="event-template" defaultValue="补充上下文" onChange={event => setRaw(JSON.stringify(templates[event.target.value], null, 2))}>{Object.keys(templates).map(name => <option key={name}>{name}</option>)}</select></div><textarea aria-label="原始事件 JSON" className="code-editor" rows={9} value={raw} onChange={event => setRaw(event.target.value)} spellCheck={false} /><label className="checkbox"><input type="checkbox" checked={experimental} onChange={event => setExperimental(event.target.checked)} />实验性发送：允许未知事件名</label><div className="composer-bottom"><span>不绕过权限或传输限制</span><button className="secondary small" disabled={!active || busy} onClick={async () => { setError(''); setBusy(true); try { await send(JSON.parse(raw), experimental); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }}><Send size={13} />发送事件</button></div>{error && <p className="field-error" role="alert">{error}</p>}</div>
    </div>}
  </section>;
}
