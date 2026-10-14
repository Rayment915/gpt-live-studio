import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseDocument } from '../server/knowledge/parser';
const results: Record<string, unknown>[] = [];
for (const name of ['sample.txt', 'sample.md', 'sample.markdown', 'sample.docx', 'sample.doc', 'sample.pptx', 'sample.ppt', 'sample.pdf', 'scan.pdf', 'encrypted.pdf', 'corrupt.pdf', 'corrupt.docx', 'corrupt.pptx', 'corrupt.doc', 'corrupt.ppt']) {
  const expectedFailure = /^(encrypted|corrupt)/.test(name);
  try {
    const { parsed } = await parseDocument(await readFile(`output/knowledge-fixtures/${name}`), extname(name));
    const text = parsed.sections.map(s => s.text).join('\n');
    const containsFacts = /7300/.test(text) && /14/.test(text) && (name === 'scan.pdf' || /蓝鲸/.test(text));
    results.push({ name, success: !expectedFailure && containsFacts, pagesOrSections: parsed.sections.length, tokens: parsed.tokens, containsFacts });
  } catch (error) { results.push({ name, success: expectedFailure, error: (error as Error).message }); }
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile('output/knowledge-parser-smoke.json', JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2));
if (results.some(item => !item.success)) process.exitCode = 1;
