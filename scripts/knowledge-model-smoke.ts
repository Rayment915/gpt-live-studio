import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { BlobKnowledgeStore } from '../server/knowledge/store';
import { KnowledgeService } from '../server/knowledge/service';
import { SCENES } from '../shared/scenarios';

// Supplemental standalone Responses test; does not substitute for Live hosted delegation.
const service = new KnowledgeService(new BlobKnowledgeStore());
const snapshot = await service.snapshot('full');
const evidence = await service.fullEvidence(snapshot);
const output = JSON.stringify({ status: 'ok', mode: 'full', evidence });
const input: any[] = [{ role: 'user', content: '请查知识库：星河实验室蓝鲸项目预算多少，设备能借几天？提供文档引用。' }];
const start = Date.now();
const request = async () => {
  const response = await fetch(new URL('/openai/v1/responses', process.env.AZURE_OPENAI_ENDPOINT), { method: 'POST', headers: { 'api-key': process.env.AZURE_OPENAI_API_KEY!, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.RESPONSES_DEPLOYMENT, instructions: SCENES.knowledge.backend, tools: SCENES.knowledge.tools, reasoning: { effort: 'low' }, input, max_output_tokens: 2048 }), signal: AbortSignal.timeout(180_000) });
  const result = await response.json(); if (!response.ok) throw new Error(`Responses ${response.status}: ${result.error?.message}`); return result;
};
try {
  const initial = await request();
  const calls = initial.output.filter((item: any) => item.type === 'function_call');
  if (!calls.length) throw new Error('Model did not call search_knowledge');
  input.push(...initial.output);
  for (const call of calls) {
    if (call.name !== 'search_knowledge') throw new Error('Unexpected tool');
    input.push({ type: 'function_call_output', call_id: call.call_id, output });
  }
  const result = await request();
  const answer = result.output.flatMap((item: any) => item.content ?? []).filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('');
  const report = { testedAt: new Date().toISOString(), transport: 'standalone Responses (not Live)', model: result.model, evidenceBytes: Buffer.byteLength(output), elapsedMs: Date.now() - start, answer, success: /7300|7,300/.test(answer) && /14/.test(answer), usage: result.usage };
  await writeFile('output/knowledge-model-smoke.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
} catch (error) { const report = { testedAt: new Date().toISOString(), success: false, evidenceBytes: Buffer.byteLength(output), error: String(error) }; await writeFile('output/knowledge-model-smoke.json', JSON.stringify(report, null, 2)); console.log(report); process.exitCode = 1; }
