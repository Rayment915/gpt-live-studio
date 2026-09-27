import { describe, expect, it } from 'vitest';
import { allowedEndpoint, originAllowed, parseCookie, sameToken } from '../server/security';

describe('trusted backend boundaries', () => {
  it('rejects arbitrary proxy destinations', () => {
    for (const url of ['http://demo.openai.azure.com', 'https://evil.com', 'https://demo.openai.azure.com.evil.com', 'https://user:pass@demo.openai.azure.com', 'https://demo.openai.azure.com:444', 'https://demo.openai.azure.com/path']) expect(() => allowedEndpoint(url)).toThrow();
    expect(allowedEndpoint('https://demo.openai.azure.com/').hostname).toBe('demo.openai.azure.com');
  });
  it('requires exact origins and constant-time tokens', () => {
    const origins = new Set(['http://localhost:3000']);
    expect(originAllowed('http://localhost:3000', origins)).toBe(true);
    expect(originAllowed('http://localhost:3000.evil.com', origins)).toBe(false);
    expect(originAllowed(undefined, origins)).toBe(false);
    expect(sameToken('abc', 'abc')).toBe(true);
    expect(sameToken('abc', 'abcd')).toBe(false);
    expect(sameToken(undefined, 'abcd')).toBe(false);
    expect(parseCookie('other=1; studio_owner=123', 'studio_owner')).toBe('123');
  });
});
