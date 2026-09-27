import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashAdminPassword(password: string, salt = randomBytes(16)): string {
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyAdminPassword(encoded: string, username: unknown, password: unknown): boolean {
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(encoded);
  if (!match) throw new Error('STUDIO_ADMIN_PASSWORD_HASH 格式无效');
  if (typeof password !== 'string' || Buffer.byteLength(password) > 128) return false;
  const actual = scryptSync(password, Buffer.from(match[1], 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(match[2], 'hex')) && username === 'admin';
}

export function validateAdminPasswordHash(encoded: string): void {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/i.test(encoded)) throw new Error('STUDIO_ADMIN_PASSWORD_HASH 格式无效');
}

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
