import { timingSafeEqual } from 'node:crypto';

export function allowedEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (endpoint.protocol !== 'https:' || !/^[a-z0-9-]+\.openai\.azure\.com$/i.test(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.port || (endpoint.pathname !== '/' && endpoint.pathname !== '') || endpoint.search || endpoint.hash) throw new Error('AZURE_OPENAI_ENDPOINT 必须是 https://资源名.openai.azure.com');
  return endpoint;
}

export function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function originAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  return typeof origin === 'string' && allowed.has(origin);
}
