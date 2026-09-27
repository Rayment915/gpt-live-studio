import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronDown, CircleHelp, Clock3, Headphones, Info, LoaderCircle, LogOut, Mic, MicOff, Play, Radio, Send, Settings2, ShieldCheck, Square, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { DEFAULT_CONFIG, validateConfig, type Event, type SessionConfig, type Transport } from '../shared/protocol';
import { sceneConfig, validateSceneConfig, type SceneId } from '../shared/scenarios';
import { ConfigPanel } from './components/ConfigPanel';
import { DelegationPanel } from './components/DelegationPanel';
import { EventConsole } from './components/EventConsole';
import { Waveform } from './components/Waveform';
import { LiveClient } from './lib/client';
import { emptyState, groupTranscripts, reduceEvent } from './lib/state';

type PublicConfig = { configured: boolean; endpoint: string; deployment: string; responsesDeployment: string; csrf: string; authMode?: string; defaultConfig: SessionConfig; maxSessionSeconds: number };
type Status = 'idle' | 'connecting' | 'live' | 'closing' | 'ended';
const statusLabels: Record<Status, string> = { idle: '准备就绪', connecting: '正在连接', live: '会话进行中', closing: '正在结束', ended: '会话已结束' };
const formatTime = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function App() {
  const [connection, setConnection] = useState<PublicConfig>();
  const [config, setConfig] = useState<SessionConfig>(DEFAULT_CONFIG);
  const [scene, setScene] = useState<SceneId>('home');
  const [json, setJsonValue] = useState(JSON.stringify(DEFAULT_CONFIG, null, 2));
  const [jsonError, setJsonError] = useState('');
  const [transport, setTransport] = useState<Transport>('webrtc');
  const [inputSource, setInputSource] = useState<'microphone' | 'file'>('microphone');
  const [status, setStatus] = useState<Status>('idle');
  const [state, setState] = useState(emptyState);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDevice, setMicDevice] = useState('');
  const [outputDevice, setOutputDevice] = useState('');
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [context, setContext] = useState('');
  const [contextMode, setContextMode] = useState('thinking');
  const [tab, setTab] = useState('studio');
  const [elapsed, setElapsed] = useState(0);
  const [upload, setUpload] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [muting, setMuting] = useState(false);
  const client = useRef<LiveClient | undefined>(undefined);
  const startConfig = useRef<SessionConfig | undefined>(undefined);
  const started = useRef(0);
  const transcriptBottom = useRef<HTMLDivElement>(null);
  const transcriptBox = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const waveformTick = useState(0)[1];
  const active = status === 'live';
  const locked = ['connecting', 'live', 'closing'].includes(status);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config', { signal: controller.signal }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; }).then((data: PublicConfig) => { if (!controller.signal.aborted) { const initial = sceneConfig('home', data.defaultConfig, data.responsesDeployment); setConnection(data); setConfig(initial); setJsonValue(JSON.stringify(initial, null, 2)); } }).catch(reason => { if (!controller.signal.aborted) setError(`无法读取配置：${reason.message}`); });
    return () => { controller.abort(); client.current?.dispose(); };
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => { if (followTranscript.current) transcriptBottom.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [state.transcripts.length]);
  useEffect(() => {
    const changed = () => { void refreshDevices(); };
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', changed);
  }, []);
  useEffect(() => {
    if (!help) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('.help-dialog')!;
    const elements = () => [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex="0"]')];
    elements()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelp(false);
      if (event.key !== 'Tab') return;
      const focusable = elements();
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [help]);

  function changeConfig(value: SessionConfig) { validateSceneConfig(scene, value, connection?.responsesDeployment ?? 'gpt-6-luna'); setConfig(value); setJsonValue(JSON.stringify(value, null, 2)); setJsonError(''); }
  function chooseScene(value: SceneId) { if (locked) return; const next = sceneConfig(value, config, connection?.responsesDeployment ?? 'gpt-6-luna'); setScene(value); setError(''); setConfig(next); setJsonValue(JSON.stringify(next, null, 2)); setJsonError(''); }
  function editJson(value: string) { setJsonValue(value); try { const parsed = validateConfig(JSON.parse(value)); validateSceneConfig(scene, parsed, connection?.responsesDeployment ?? 'gpt-6-luna'); setConfig(parsed); setJsonError(''); } catch (reason) { setJsonError(String(reason)); } }
  async function refreshDevices() { if (navigator.mediaDevices) setDevices(await navigator.mediaDevices.enumerateDevices()); }
  function receive(event: Event) {
    setState(current => reduceEvent(current, event));
    if (['session.input_audio.muted', 'session.input_audio.unmuted', 'error'].includes(event.type)) setMuting(false);
    if (event.type === 'session.started') setStatus('live');
    if (event.type === 'studio.closing') setStatus('closing');
    if (event.type === 'session.closed') setNotice(`会话已结束 · ${event.reason ?? ''} · 最终用量 ${event.usage?.seconds ?? 0} 秒`);
  }
  async function start() {
    setError('');
    if ((transport === 'webrtc' || inputSource === 'microphone') && !navigator.mediaDevices?.getUserMedia) return setError('当前页面无法使用麦克风，请用 localhost 或 HTTPS 打开');
    if (jsonError) return setError('请先修正 Session JSON');
    client.current?.dispose();
    setState(emptyState()); setElapsed(0); setUpload(null); setSpeakerMuted(false); setMuting(false);
    setStatus('connecting');
    const current = new LiveClient(connection!.csrf, event => { if (client.current === current) receive(event); }, () => { if (client.current === current) { setStatus('ended'); setUpload(null); } }, message => { if (client.current === current) setError(message); });
    client.current = current;
    try {
      const valid = validateConfig(config);
      validateSceneConfig(scene, valid, connection!.responsesDeployment);
      startConfig.current = structuredClone(valid);
      started.current = Date.now();
      await current.start(valid, transport, micDevice, inputSource, scene);
      if (current.disposed) return;
      if (outputDevice) await current.audio.outputDevice(outputDevice).catch(reason => setNotice(String(reason)));
      setStatus('live'); waveformTick(value => value + 1); await refreshDevices();
    } catch (reason) {
      if (current.id) await current.close(); else current.dispose();
      if (client.current !== current) return;
      setStatus('ended');
      const failure = reason as Error;
      setError(failure.name === 'NotAllowedError' ? '麦克风权限被拒绝。请在浏览器地址栏允许麦克风，然后重新开始。' : failure.name === 'NotFoundError' ? '未检测到麦克风。请连接设备后重试。' : failure.name === 'NotReadableError' ? '麦克风被占用或不可读取，请检查系统输入设备。' : failure.message);
    }
  }
  async function send(event: Event, experimental = false) {
    if (!client.current || !active) throw new Error('请先开始会话');
    await client.current.send(event, experimental);
    setState(current => reduceEvent(current, event, 'out'));
  }
  async function act(action: () => Promise<unknown>) { try { await action(); } catch (reason) { setError(String(reason)); } }
  async function end() { setStatus('closing'); await client.current?.close(); }
  async function updateResponses() {
    await act(async () => {
      if (config.delegation?.type !== 'responses' || startConfig.current?.delegation?.type !== 'responses') throw new Error('切换委派模式需重新开始会话');
      await send({ type: 'session.update', session: { delegation: config.delegation } });
      setNotice('已发送委派配置更新；以 session.updated 确认结果');
    });
  }
  function exportSession() {
    const payload = { exportedAt: new Date().toISOString(), deployment: connection?.deployment, scene, transport, retention: '仅保留最近 800 个事件和 3000 个转写片段；不含录音', finalUsageConfirmed: state.finalUsage, ...state };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `gpt-live-${new Date().toISOString().replaceAll(':', '-')}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('已导出当前内存中的记录，不含音频载荷或密钥');
  }
  const visibleTranscripts = useMemo(() => groupTranscripts(state.transcripts).slice(-200), [state.transcripts]);
  const inputText = state.transcripts.filter(item => item.speaker === 'input').map(item => item.text).join('');
  const outputText = state.transcripts.filter(item => item.speaker === 'output').map(item => item.text).join('');

  return <div className="app-shell">
    <header className="topbar"><a href="/" className="brand" aria-label="GPT-Live Studio 首页"><span className="brand-symbol"><AudioLines size={23} strokeWidth={1.7} /></span><span>GPT-Live <strong>Studio</strong></span><span className="preview-tag">PREVIEW</span></a><nav className="desktop-nav" aria-label="工作区"><span className="nav-active">体验工作台</span><button onClick={() => setHelp(true)}>协议与使用 <ArrowUpRightIcon /></button></nav><div className="topbar-right"><span className="azure-brand"><span className="azure-mark">A</span> Azure Foundry</span><span className="header-rule" />{connection?.authMode === 'password' && <button className="text-button" onClick={() => act(async () => { const result = await fetch('/logout', { method: 'POST', headers: { 'X-Studio-Csrf': connection.csrf } }); if (!result.ok) throw new Error('退出失败'); location.assign('/login'); })}><LogOut size={14} />退出登录</button>}<button className="icon-button" aria-label="使用帮助" onClick={() => setHelp(true)}><CircleHelp size={19} /></button></div></header>
    <main>
      <section className="workspace-heading"><div><div className="eyebrow"><span />FULL-DUPLEX VOICE LAB</div><h1>对话，不必等待。</h1><p>边听边说，自然插话。探索 GPT-Live 的实时语音能力。</p></div><div className="workspace-meta"><div className="deployment-badge"><span className="model-dot" /><code>{connection?.deployment ?? 'gpt-live-1'}</code><span>部署</span></div><span className="endpoint-label" title={connection?.endpoint}>{connection?.endpoint ? new URL(connection.endpoint).hostname.split('.')[0] : '正在读取配置…'}</span></div></section>
      {connection && !connection.configured && <div className="alert warning"><Info size={17} /><span>后端还未配置密钥。请填写项目 .env 中的 AZURE_OPENAI_API_KEY 并重启；不要将密钥填进前端 JSON。</span></div>}
      {error && <div className="alert error" role="alert"><Info size={17} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={16} /></button></div>}
      <div className="mobile-tabs" role="tablist" aria-label="工作区分区">{[['settings', '会话设置'], ['studio', '语音体验'], ['tasks', '委派任务']].map(([value, title]) => <button role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)} key={value}>{title}</button>)}</div>
      <div className={`workspace-grid mobile-${tab}`}>
        <ConfigPanel config={config} change={changeConfig} scene={scene} chooseScene={chooseScene} transport={transport} setTransport={setTransport} inputSource={inputSource} setInputSource={setInputSource} locked={locked} update={updateResponses} notify={setNotice} responsesModel={connection?.responsesDeployment ?? 'gpt-6-luna'} json={json} setJson={editJson} jsonError={jsonError} />
        <section className="studio-panel panel" aria-label="语音体验"><div className="studio-topline"><div className={`session-status ${status}`}><span />{statusLabels[status]}</div><div className="session-clock"><Clock3 size={13} /><span>{formatTime(elapsed)}</span><span className="transport-tag">{transport === 'webrtc' ? 'WEBRTC' : 'WEBSOCKET'}</span></div></div>
          <div className="duplex-heading"><span className="duplex-title">TWO VOICES.<br /><span>ONE CONVERSATION.</span></span><div className="duplex-symbol" aria-hidden="true"><span /><span /><ArrowRight size={22} /><ArrowRight size={22} /></div></div>
          <div className="audio-tracks">
            <div className="audio-track input-track"><div className="track-label"><span className="track-icon"><Mic size={16} /></span><div><strong>你的声音</strong><span>INPUT</span></div><span className="track-status">{active ? state.inputMuted ? '已静音' : upload !== null ? '文件输入' : '正在聆听' : '等待连接'}</span></div><Waveform analyser={client.current?.audio.inputAnalyser} color="#087F8C" active={active && !state.inputMuted && upload === null} /><p className="track-preview">{inputText ? inputText.slice(-65) : '你的话，会在这里被听见。'}</p></div>
            <div className="track-ruler" aria-hidden="true"><span>同一时间轴</span><div /><span>同时听 · 同时说</span></div>
            <div className="audio-track output-track"><div className="track-label"><span className="track-icon"><AudioLines size={17} /></span><div><strong>GPT-Live</strong><span>OUTPUT</span></div><span className="track-status">{active ? speakerMuted ? '本机静音' : '已连接' : '等待连接'}</span></div><Waveform analyser={client.current?.audio.outputAnalyser} color="#245DDB" active={active || status === 'closing'} /><p className="track-preview">{outputText ? outputText.slice(-65) : '不必等它说完，你可以随时开口。'}</p></div>
          </div>
          <div className="call-controls"><button className={`control-button ${state.inputMuted ? 'toggled' : ''}`} disabled={!active || muting} aria-label={state.inputMuted ? '取消输入静音' : '输入静音'} title="发送输入静音命令" onClick={() => act(async () => { setMuting(true); try { await send({ type: state.inputMuted ? 'session.input_audio.unmute' : 'session.input_audio.mute' }); } catch (reason) { setMuting(false); throw reason; } })}>{state.inputMuted ? <MicOff size={18} /> : <Mic size={18} />}</button>
            {locked ? <button className="primary end-call" disabled={status !== 'live'} onClick={end}>{status === 'live' ? <Square size={15} fill="currentColor" /> : <LoaderCircle size={17} className="spin" />}{status === 'live' ? '结束会话' : status === 'connecting' ? '正在连接…' : '等待最终用量…'}</button> : <button className="primary start-call" disabled={!connection?.configured || !!jsonError} onClick={start}><Radio size={19} />{status === 'ended' ? '开始新会话' : '开始体验'}<ArrowRight size={16} /></button>}
            <button className={`control-button ${speakerMuted ? 'toggled' : ''}`} disabled={!active} aria-label={speakerMuted ? '取消扬声器静音' : '扬声器静音'} title="仅静音本机扬声器" onClick={() => { setSpeakerMuted(!speakerMuted); client.current?.audio.speakerMuted(!speakerMuted); }}>{speakerMuted ? <VolumeX size={19} /> : <Volume2 size={19} />}</button>
          </div>
          <div className="connection-hint">{active ? <><ShieldCheck size={12} />音频实时传输 · 不自动保存录音</> : <><Headphones size={13} />建议佩戴耳机，获得更自然的双向对话体验</>}</div>
          <div className="devices-row"><button className="text-button muted-text" onClick={() => { setDeviceOpen(!deviceOpen); void refreshDevices(); }}><Settings2 size={13} />音频设备<ChevronDown size={12} /></button>{active && <button className="text-button muted-text" onClick={() => act(() => client.current!.audio.resume())}>没有声音？恢复播放</button>}{transport === 'websocket' && <label className={`upload-button ${!active || state.inputMuted ? 'disabled' : ''}`}><Upload size={13} />上传音频<input type="file" accept="audio/*" disabled={!active || state.inputMuted || upload !== null} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; setUpload(0); void act(async () => { try { await client.current!.audio.upload(file, audio => client.current!.sendAudio(audio), setUpload); } finally { setUpload(null); } }); }} /></label>}</div>
          {deviceOpen && <div className="device-settings"><label>输入设备<select aria-label="输入设备" value={micDevice} onChange={event => { setMicDevice(event.target.value); if (active) void act(() => client.current!.changeMicrophone(event.target.value)); }}><option value="">系统默认麦克风</option>{devices.filter(device => device.kind === 'audioinput' && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select></label><label>输出设备<select aria-label="输出设备" value={outputDevice} onChange={event => { setOutputDevice(event.target.value); if (active) void act(() => client.current!.audio.outputDevice(event.target.value)); }}><option value="">系统默认扬声器</option>{devices.filter(device => device.kind === 'audiooutput' && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `扬声器 ${index + 1}`}</option>)}</select></label><small>授权麦克风后显示设备名称。输出切换取决于浏览器支持。</small></div>}
          {upload !== null && <div className="upload-progress"><progress max={100} value={upload} /><span>文件输入 {upload}%</span><button className="text-button" onClick={() => { client.current?.audio.cancelUpload(); setUpload(null); }}>停止上传</button></div>}
          <section className="transcript-section"><div className="section-heading"><h2>实时转写 <span>TRANSCRIPT</span></h2><span>按句合并 · 实时更新</span></div><div className="transcript-scroll" ref={transcriptBox} onScroll={() => { const box = transcriptBox.current!; followTranscript.current = box.scrollHeight - box.scrollTop - box.clientHeight < 50; }}>
            {!visibleTranscripts.length ? <div className="transcript-empty"><span className="quote-mark">“</span><p>从一句「你好」开始</p><span>连接后，你和模型的实时转写会出现在这里</span></div> : visibleTranscripts.map((fragment, index) => <div className={`transcript-fragment ${fragment.speaker}`} key={`${fragment.speaker}-${fragment.start}-${index}`}><span className="speaker-label">{fragment.speaker === 'input' ? '你' : 'LIVE'}</span><p>{fragment.text}</p><time>{formatTime(fragment.start / 1000)}</time></div>)}<div ref={transcriptBottom} /></div>
          </section>
          <div className="context-composer"><div className="context-top"><select aria-label="上下文追加方式" value={contextMode} onChange={event => setContextMode(event.target.value)}><option value="thinking">补充上下文</option><option value="instructions">追加指令</option><option value="commentary">请模型说出</option></select><span>单条最多 500 tokens · 服务端校验</span></div><div className="context-input"><textarea aria-label="会话上下文" rows={2} placeholder={contextMode === 'thinking' ? '给模型一点背景，不必打断对话…' : contextMode === 'instructions' ? '追加可信应用指令，不要粘贴不可信内容…' : '输入希望模型说出的内容，它可能会转述…'} value={context} onChange={event => setContext(event.target.value)} /><button className="send-context" aria-label="发送上下文" disabled={!active || !context.trim()} onClick={() => act(async () => { await send({ type: `session.${contextMode}.append`, delegation_id: null, content: context }); setContext(''); setNotice('内容已发送；接受注入不代表已朗读'); })}><Send size={17} /></button></div></div>
        </section>
        <DelegationPanel state={state} scene={scene} responsesModel={connection?.responsesDeployment ?? 'gpt-6-luna'} active={active} sendResult={async (id, content, speak) => { await send({ type: speak ? 'session.commentary.append' : 'session.thinking.append', delegation_id: id, content }); setNotice('委派结果已发送，等待注入确认'); }} />
      </div>
      <div className="session-footer"><div><span><Activity size={13} />{transport === 'websocket' ? 'PCM16 · 24 kHz · Mono' : 'WebRTC · 协商音频'}</span><span><Clock3 size={13} />语音用量 <strong>{state.seconds}s</strong>{state.finalUsage ? ' · 已确认' : ' · 累计快照'}</span><span className="context-meter">上下文 <meter min={0} max={1} value={state.contextRatio} />{Math.round(state.contextRatio * 100)}%</span></div><button className="text-button" onClick={exportSession}><ArrowDownToLine size={14} />导出会话</button></div>
      {Object.keys(state.backendUsage).length > 0 && <details className="backend-usage"><summary>委派模型用量（与语音分开计费）</summary><pre>{JSON.stringify(state.backendUsage, null, 2)}</pre></details>}
      {status === 'ended' && !state.finalUsage && state.events.length > 0 && <p className="usage-warning">未收到 session.closed，最终语音用量未确认；当前显示最近一次快照。</p>}
      <EventConsole state={state} active={active} send={send} />
      <footer className="page-footer"><span><ShieldCheck size={13} />会话仅保留在本页，刷新后清除。导出前请检查敏感内容。</span><span>GPT-LIVE STUDIO <span className="footer-dot">·</span> BUILT FOR EXPLORATION</span></footer>
    </main>
    {notice && <div className="toast" role="status"><Check size={16} />{notice}</div>}
    {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape') setHelp(false); }}><div className="panel-heading"><h2 id="help-title">开始一段真正的双向对话</h2><button autoFocus className="icon-button" aria-label="关闭使用帮助" onClick={() => setHelp(false)}><X size={19} /></button></div><div className="help-content"><p>选择连接方式和指令，点击“开始体验”并授权麦克风。说话时无需等待模型说完。</p><h3>这不是普通的聊天接口</h3><p>GPT-Live 使用专属 <code>/openai/v1/live</code> 协议。文本通过上下文注入，实时字幕不是完整轮次；注入回执也不保证内容已被说出。</p><h3>参数与兼容性</h3><p>开始后的模型、声音和初始指令不可替换。运行时只更新 Responses 委派配置，且作为完整委派对象发送。声音、工具、委派模型参数均由实际部署验证。</p><h3>隐私与费用</h3><p>Azure 会处理实时音频。Studio 不自动录音；语音会话中的静默也可能计费，委派推理另计。本应用会在 {Math.round((connection?.maxSessionSeconds ?? 1800) / 60)} 分钟后关闭会话。</p><h3>调试与委派</h3><p>展开事件控制台查看原始协议。在 Responses 模式，内置时间查询使用真实系统时间，商品查询使用固定模拟数据。未知函数只能手动回填，不会执行任意代码。</p><p>官方参考：Microsoft Learn「GPT-Live event API reference」「Use GPT-Live via WebRTC」「Delegate work in GPT-Live」。项目 docs/CAPABILITIES.md 记录实测范围和未确认项。</p></div></section></div>}
  </div>;
}

function ArrowUpRightIcon() { return <span aria-hidden="true" className="external-arrow">↗</span>; }
