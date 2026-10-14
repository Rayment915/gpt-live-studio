/** Upstream may echo function outputs; keep document bodies off browser debug feeds. */
export function withoutKnowledgeBodies<T>(event: T): T {
  function scrub(value: any): any {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = {};
    for (const [key, field] of Object.entries(value)) {
      result[key] = value.type === 'function_call_output' && key === 'output' ? '[知识库结果已提交；正文不写入事件日志]' : scrub(field);
    }
    return result;
  }
  return scrub(event);
}
