import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const query = args => {
  try { return execFileSync('az', [...args, '-o', 'tsv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('无法读取开发 Search 凭据；请检查 az login 和资源权限。本地 .env 尚未修改。'); }
};
const values = {
  RESPONSES_DEPLOYMENT: 'gpt-6-luna',
  RESPONSES_DEPLOYMENTS: 'gpt-6-luna,gpt-live-dev-sol',
  KNOWLEDGE_STORAGE_CONNECTION_STRING: '',
  KNOWLEDGE_STORAGE_URL: 'https://glragdev678b10.blob.core.windows.net',
  KNOWLEDGE_CONTAINER: 'gpt-live-dev',
  KNOWLEDGE_SEARCH_ENDPOINT: 'https://gptlive-rag-dev-678b10.search.windows.net',
  KNOWLEDGE_SEARCH_KEY: query(['search', 'admin-key', 'show', '-g', 'rg-gpt-live-rag-dev', '--service-name', 'gptlive-rag-dev-678b10', '--query', 'primaryKey']),
  KNOWLEDGE_OCR_ENDPOINT: 'https://gptlive-ocr-dev-678b10.cognitiveservices.azure.com',
  KNOWLEDGE_OCR_KEY: '', // Dev OCR enforces Entra authentication.
  KNOWLEDGE_EMBEDDING_ENDPOINT: 'https://foundry-asia2026.openai.azure.com',
  KNOWLEDGE_EMBEDDING_DEPLOYMENT: 'gpt-live-dev-embedding',
  KNOWLEDGE_EMBEDDING_KEY: '', // Entra for local worker and Search managed identity.
  KNOWLEDGE_INDEX_PREFIX: 'gpt-live-dev',
};
if (process.argv.includes('--azurite')) {
  values.KNOWLEDGE_STORAGE_CONNECTION_STRING = 'UseDevelopmentStorage=true';
}
let contents = readFileSync('.env', 'utf8');
for (const [name, value] of Object.entries(values)) {
  const line = `${name}=${JSON.stringify(value)}`;
  const expression = new RegExp(`^${name}=.*$`, 'm');
  contents = expression.test(contents) ? contents.replace(expression, () => line) : `${contents.trimEnd()}\n${line}\n`;
}
writeFileSync('.env.knowledge-update', contents, { mode: 0o600 });
renameSync('.env.knowledge-update', '.env');
console.log(`Updated ${Object.keys(values).length} development settings in private .env; no secrets printed.`);
