import { useState } from 'react';
import { ArrowDown, ArrowUpRight, Check, GitBranch, Send, Wrench } from 'lucide-react';
import type { StudioState } from '../lib/state';
import { SCENES, type SceneId } from '../../shared/scenarios';

export function DelegationPanel({ state, scene, responsesModel, active, sendResult }: { state: StudioState; scene: SceneId; responsesModel: string; active: boolean; sendResult: (id: string, content: string, speak: boolean) => Promise<void> }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [speak, setSpeak] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  async function perform(id: string, action: () => Promise<void>) {
    setBusy(id); setError('');
    try { await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(undefined); }
  }
  return <aside className="delegation-panel panel" aria-label="委派任务">
    <div className="panel-heading"><h2><GitBranch size={16} />委派任务</h2><span className="count">{state.delegations.length}</span></div>
    <div className="delegation-body">
      <div className="aside-caption"><span className="tiny-dot" />对话继续，任务独立运行</div>
      {!state.delegations.length && <div className="delegation-empty">
        <div className="routing-diagram" aria-hidden="true"><div className="route-live"><span className="mini-bars">ııı</span><span>LIVE</span></div><div className="route-connector"><ArrowDown size={18} /></div><div className="route-tool"><Wrench size={17} /><span>任务处理</span></div><div className="route-loop"><ArrowUpRight size={18} /></div></div>
        <h3>把复杂的事交给后台</h3><p>需要推理、查询或工具时，<br />委派任务会出现在这里。<br />你们的对话不必暂停。</p>
        <div className="example-note"><span>可以试着说</span><p>{SCENES[scene].example}</p><small>委派模型：{state.sceneState ? responsesModel : '等待连接'}</small></div>
      </div>}
      {state.sceneState?.scene === 'home' && <section className="scene-state" aria-label="模拟家电状态"><h3>模拟家电</h3>{state.sceneState.devices?.map(device => <p key={device.id}>{device.name} · {device.power ? '开启' : '关闭'}{device.brightness !== undefined ? ` · ${device.brightness}%` : ''}{device.temperature !== undefined ? ` · ${device.temperature}°C` : ''}</p>)}</section>}
      {state.sceneState?.scene === 'meeting' && <section className="scene-state" aria-label="模拟会议记录"><h3>模拟日程与记录</h3>{state.sceneState.agenda?.map(item => <p key={item.time}>{item.time} · {item.title}</p>)}{state.sceneState.notes?.map((note, index) => <article key={index}><strong>记录 {index + 1}：{note.summary}</strong>{note.decisions.map((decision, itemIndex) => <p key={`decision-${itemIndex}`}>决定 · {decision}</p>)}{note.actions.map((action, itemIndex) => <p key={`action-${itemIndex}`}>待办 · {action}</p>)}</article>)}</section>}
      {state.delegations.map(delegation => <article className="task-card" key={delegation.id}>
        <div className="task-title"><GitBranch size={15} /><strong>{delegation.target === 'client' ? '应用委派' : '模型委派'}</strong><span>{delegation.status}</span></div>
        <code className="task-id">{delegation.id}</code>
        {delegation.text && <p className="delegation-text">{delegation.text}</p>}
        {delegation.sources.length > 0 ? <div className="scene-sources"><strong>可核验来源</strong>{delegation.sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>)}</div> : scene === 'search' && delegation.status === '后端响应完成' && <p className="field-help">未提供可核验来源</p>}
        {delegation.target === 'client' && <>
          <p className="field-help">结合左侧转写理解任务；委派事件本身不包含任务正文。</p>
          <textarea aria-label={`委派结果 ${delegation.id}`} placeholder="输入经过确认的结果…" value={drafts[delegation.id] ?? ''} onChange={event => setDrafts({ ...drafts, [delegation.id]: event.target.value })} rows={3} />
          <label className="checkbox"><input type="checkbox" checked={speak[delegation.id] !== false} onChange={event => setSpeak({ ...speak, [delegation.id]: event.target.checked })} />让模型说出结果</label>
          <button className="secondary small" disabled={!active || busy === delegation.id || !drafts[delegation.id]?.trim()} onClick={() => perform(delegation.id, () => sendResult(delegation.id, drafts[delegation.id], speak[delegation.id] !== false))}><Send size={13} />回填结果</button>
        </>}
        {state.tools.filter(call => call.delegationId === delegation.id).map(call => <div className="tool-card" key={call.callId}>
          <div className="tool-name"><Wrench size={14} /><code>{call.name}</code></div><pre>{call.arguments}</pre>
          {call.state === 'submitted' ? <><span className={call.output?.includes('"ok":false') ? 'field-error' : 'success-label'}>{!call.output?.includes('"ok":false') && <Check size={13} />}{call.output?.includes('"ok":false') ? '参数无效，已反馈模型修正' : '模拟工具结果已提交'}</span><pre>{call.output}</pre></> : <span className="field-help">服务器正在校验并执行模拟工具…</span>}
        </div>)}
      </article>)}
      {error && <p role="alert" className="field-error">{error}</p>}
    </div>
    <div className="aside-bottom"><Wrench size={14} /><p>仅模拟工具自动执行<br /><span>真实外部操作仍需授权</span></p></div>
  </aside>;
}
