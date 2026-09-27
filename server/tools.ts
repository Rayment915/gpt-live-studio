import { object, type Event } from '../shared/protocol.js';

export type ToolCall = {
  callId: string;
  delegationId: string;
  batchId: string;
  name: string;
  arguments: string;
  state: 'pending' | 'running' | 'submitted';
  output?: string;
};

export class ToolLedger {
  calls = new Map<string, ToolCall>();
  batches = new Map<string, { sealed: boolean; continued: boolean }>();
  activeBatch = new Map<string, string>();

  ingest(envelope: Event) {
    if (envelope.type !== 'response.event' || !object(envelope.event)) return;
    const event = envelope.event;
    const delegationId = envelope.delegation_id;
    if (typeof delegationId !== 'string') return;
    if (event.type === 'response.created') {
      const batchId = `${delegationId}:${event.response?.id ?? event.response_id ?? this.batches.size}`;
      this.activeBatch.set(delegationId, batchId);
      this.batches.set(batchId, { sealed: false, continued: false });
    }
    if (event.type === 'response.in_progress') {
      const previous = this.activeBatch.get(delegationId) ?? `${delegationId}:initial`;
      if (this.batches.get(previous)?.continued) {
        const next = `${delegationId}:continuation-${this.batches.size}`;
        this.activeBatch.set(delegationId, next);
        this.batches.set(next, { sealed: false, continued: false });
      }
    }
    const batchId = this.activeBatch.get(delegationId) ?? `${delegationId}:initial`;
    if (!this.batches.has(batchId)) this.batches.set(batchId, { sealed: false, continued: false });
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const item = event.item;
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string' || this.calls.has(item.call_id)) return;
      this.calls.set(item.call_id, { callId: item.call_id, delegationId, batchId, name: item.name, arguments: item.arguments, state: 'pending' });
    }
    if (event.type === 'response.completed') this.batches.get(batchId)!.sealed = true;
  }

  claim(callId: string): ToolCall {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'pending') throw new Error('工具调用不存在或已处理');
    call.state = 'running';
    return call;
  }

  readyBatches(): string[] {
    return [...this.batches.entries()].filter(([batchId, batch]) => {
      const calls = [...this.calls.values()].filter(call => call.batchId === batchId);
      return batch.sealed && !batch.continued && calls.length > 0 && calls.every(call => call.state === 'submitted');
    }).map(([batchId]) => batchId);
  }

  hasUnresolved(): boolean {
    return [...this.calls.values()].some(call => call.state !== 'submitted');
  }
}

export function runDemoTool(name: string, args: unknown): unknown {
  if (!object(args)) throw new Error('工具参数必须是对象');
  if (name === 'get_current_time') {
    if (typeof args.timezone !== 'string' || Object.keys(args).some(key => key !== 'timezone')) throw new Error('需要 timezone，例如 Asia/Shanghai');
    return { timezone: args.timezone, time: new Intl.DateTimeFormat('zh-CN', { timeZone: args.timezone, dateStyle: 'full', timeStyle: 'long' }).format(new Date()), iso: new Date().toISOString() };
  }
  if (name === 'lookup_demo_product') {
    if (typeof args.sku !== 'string' || Object.keys(args).some(key => key !== 'sku')) throw new Error('需要 sku，例如 STUDIO-01');
    const products: Record<string, unknown> = {
      'STUDIO-01': { name: 'Studio 监听耳机', price: 399, currency: 'CNY', stock: 12 },
      'STUDIO-02': { name: 'Studio 桌面麦克风', price: 599, currency: 'CNY', stock: 6 },
    };
    return { simulated: true, sku: args.sku, product: products[args.sku] ?? null, notice: '固定演示数据，不能下单。' };
  }
  throw new Error('未注册的工具；请检查调用后手动填写结果。服务器不会执行任意代码或 URL。');
}
