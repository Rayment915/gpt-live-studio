import { describe, expect, it } from 'vitest';
import { allowedEndpoint, hashAdminPassword, originAllowed, parseCookie, sameToken, validateAdminPasswordHash, verifyAdminPassword } from '../server/security';

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
  it('uses a salted password hash and rejects wrong identities and malformed hashes', () => {
    const encoded = hashAdminPassword('test-only-password', Buffer.alloc(16, 3));
    expect(encoded).toMatch(/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(() => validateAdminPasswordHash(encoded)).not.toThrow();
    expect(verifyAdminPassword(encoded, 'admin', 'test-only-password')).toBe(true);
    expect(verifyAdminPassword(encoded, 'Admin', 'test-only-password')).toBe(false);
    expect(verifyAdminPassword(encoded, 'admin', 'wrong')).toBe(false);
    expect(verifyAdminPassword(encoded, 'admin', 'x'.repeat(129))).toBe(false);
    expect(() => validateAdminPasswordHash('plaintext')).toThrow();
  });
});
