import { useState } from 'react';
import { Bookmark, Braces, Check, ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { validateConfig, type SessionConfig, type Transport } from '../../shared/protocol';
import { SCENE_IDS, SCENES, validateSceneConfig, type SceneId } from '../../shared/scenarios';

type Props = { config: SessionConfig; change: (config: SessionConfig) => void; scene: SceneId; chooseScene: (scene: SceneId) => void; transport: Transport; setTransport: (value: Transport) => void; inputSource: 'microphone' | 'file'; setInputSource: (value: 'microphone' | 'file') => void; locked: boolean; update: () => void; notify: (message: string) => void; responsesModel: string; json: string; setJson: (value: string) => void; jsonError: string };

export function ConfigPanel({ config, change, scene, chooseScene, transport, setTransport, inputSource, setInputSource, locked, update, notify, responsesModel, json, setJson, jsonError }: Props) {
  const [editor, setEditor] = useState(false);
  const responses = config.delegation?.type === 'responses' ? config.delegation.responses : null;
  const patch = (values: Record<string, any>) => {
    const next = { ...responses!, ...values };
    for (const key of ['reasoning', 'text']) {
      if (next[key]) {
        next[key] = Object.fromEntries(Object.entries(next[key]).filter(([, value]) => value !== ''));
        if (Object.keys(next[key]).length === 0) delete next[key];
      }
    }
    change({ ...config, delegation: { type: 'responses', responses: next } });
  };
  function savePreset() {
    try { localStorage.setItem('gpt-live-preset-v1', JSON.stringify(validateConfig(config))); notify('已保存参数预设；不保存会话转写或录音'); }
    catch (error) { notify(String(error)); }
  }
  function loadPreset() {
    try { const saved = localStorage.getItem('gpt-live-preset-v1'); if (!saved) return notify('还没有保存的参数预设'); const parsed = validateConfig(JSON.parse(saved)); validateSceneConfig(scene, parsed, responsesModel); change(parsed); notify('已载入当前场景的参数预设'); }
    catch (error) { notify(String(error)); }
  }
  return <aside className="config-panel panel" aria-label="会话设置">
    <div className="panel-heading"><h2><SlidersHorizontal size={16} />会话设置</h2><button className={`icon-button ${editor ? 'selected' : ''}`} aria-label="切换 JSON 配置编辑器" title="JSON 配置" onClick={() => setEditor(!editor)}><Braces size={17} /></button></div>
    <div className="config-content">
      <div className="field"><span className="field-title">体验场景<span className="hint-tag">开始前选择</span></span><div className="scene-options">{SCENE_IDS.map(item => <button key={item} disabled={locked} aria-pressed={scene === item} className={scene === item ? 'active' : ''} onClick={() => chooseScene(item)}><strong>{SCENES[item].title}</strong></button>)}</div><p className="field-help">{SCENES[scene].notice}</p><p className="field-help">试着说：{SCENES[scene].example}</p></div>
      <div className="field"><span className="field-title">连接方式<span className="hint-tag">开始前设置</span></span><div className="segmented"><button disabled={locked} className={transport === 'webrtc' ? 'active' : ''} onClick={() => setTransport('webrtc')}>WebRTC <span>低延迟</span></button><button disabled={locked} className={transport === 'websocket' ? 'active' : ''} onClick={() => setTransport('websocket')}>WebSocket</button></div></div>
      {transport === 'websocket' && <div className="field"><label htmlFor="input-source">输入源</label><select id="input-source" disabled={locked} value={inputSource} onChange={event => setInputSource(event.target.value as 'microphone' | 'file')}><option value="microphone">麦克风（可临时上传文件）</option><option value="file">仅上传文件（无需麦克风权限）</option></select></div>}
      {editor ? <div className="field"><label htmlFor="session-json">Session JSON</label><textarea id="session-json" className="code-editor config-json" value={json} onChange={event => setJson(event.target.value)} spellCheck={false} /><p className={jsonError ? 'field-error' : 'field-help'}>{jsonError || '合法 JSON 会同步到表单。启动字段修改后需重新开始。'}</p></div> : <>
        <div className="field"><label htmlFor="deployment">模型部署</label><div className="model-input"><span className="model-dot" /><input id="deployment" readOnly value={config.model} /><span>LIVE</span></div><p className="field-help">Azure Foundry · 专属 Live 协议</p></div>
        <div className="field"><label htmlFor="voice">声音 <span className="hint-tag">开始前设置</span></label><input id="voice" list="voices" value={config.audio?.output?.voice ?? 'marin'} onChange={event => change({ ...config, audio: { output: { voice: event.target.value } } })} /><datalist id="voices"><option value="marin" /></datalist><p className="field-help">默认 marin；自定义声音名由服务验证。</p></div>
        <div className="section-divider" />
        <div className="field"><label htmlFor="instructions">让模型如何与你交流 <span className="hint-tag">开始前设置</span></label><textarea id="instructions" rows={6} value={config.instructions ?? ''} onChange={event => change({ ...config, instructions: event.target.value })} /><p className="field-help">通话中用“追加指令”补充，不覆盖初始指令。</p></div>
        <div className="section-divider" />
        <div className="field"><span className="field-title">任务委派</span><p className="field-help">Responses · {responsesModel}；纯模拟工具经后端校验后自动执行。</p></div>
        {responses && <div className="responses-fields">
          <div className="field"><label htmlFor="backend-model">委派模型部署</label><input id="backend-model" readOnly value={responses.model ?? ''} /></div>
          <details><summary>Responses 参数 <ChevronDown size={14} /></summary><div className="field"><label htmlFor="backend-instructions">委派指令</label><textarea id="backend-instructions" rows={3} value={responses.instructions ?? ''} onChange={event => patch({ instructions: event.target.value })} /></div>
            <div className="field"><label htmlFor="max-tokens">max_output_tokens</label><input id="max-tokens" type="number" min="1" value={responses.max_output_tokens ?? 2048} onChange={event => patch({ max_output_tokens: Number(event.target.value) })} /></div>
            <div className="field"><label htmlFor="service-tier">service_tier</label><select id="service-tier" value={responses.service_tier ?? 'auto'} onChange={event => patch({ service_tier: event.target.value })}>{['auto', 'default', 'flex', 'priority'].map(value => <option key={value}>{value}</option>)}</select></div>
            <div className="field"><label htmlFor="reasoning">reasoning.effort</label><input id="reasoning" placeholder="由委派模型决定" value={responses.reasoning?.effort ?? ''} onChange={event => patch({ reasoning: { ...responses.reasoning, effort: event.target.value } })} /></div>
            <div className="field"><label htmlFor="reasoning-summary">reasoning.summary</label><select id="reasoning-summary" value={responses.reasoning?.summary ?? ''} onChange={event => patch({ reasoning: { ...responses.reasoning, summary: event.target.value } })}><option value="">未设置</option><option>auto</option><option>concise</option><option>detailed</option></select></div>
            <div className="field"><label htmlFor="verbosity">text.verbosity</label><select id="verbosity" value={responses.text?.verbosity ?? 'low'} onChange={event => patch({ text: { ...responses.text, verbosity: event.target.value } })}>{['low', 'medium', 'high'].map(value => <option key={value}>{value}</option>)}</select></div>
            <div className="field"><label htmlFor="tool-choice">tool_choice</label><select id="tool-choice" value={typeof responses.tool_choice === 'string' ? responses.tool_choice : 'custom'} onChange={event => patch({ tool_choice: event.target.value })}><option>auto</option><option>none</option><option>required</option><option value="custom" disabled>自定义（JSON）</option></select></div>
            <label className="checkbox"><input type="checkbox" checked={responses.parallel_tool_calls === true} onChange={event => patch({ parallel_tool_calls: event.target.checked })} />允许并行工具调用</label>
            <p className="field-help">工具由场景固定：{SCENES[scene].tools.map(tool => tool.type === 'function' ? tool.name : tool.type).join('、')}。其他 Responses 参数可在 JSON 编辑器配置；服务可能不支持所有值。</p>
          </details>
        </div>}
      </>}
      {locked && <div className="inline-note">启动参数的修改仅影响下一次会话。<button className="text-button" onClick={update} disabled={!!jsonError}>应用 Responses 更新</button></div>}
      <div className="preset-actions"><button onClick={savePreset}><Bookmark size={14} />保存预设</button><button disabled={locked} onClick={loadPreset}><RotateCcw size={14} />载入预设</button></div>
      <div className="privacy-note"><Check size={13} /><span>密钥只留在后端</span></div>
    </div>
  </aside>;
}
