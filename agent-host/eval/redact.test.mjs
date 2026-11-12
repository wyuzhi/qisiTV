import { test, expect } from 'bun:test';
import { redactSecrets } from './redact.mjs';

test('上游密钥被替换', () => {
  const text = redactSecrets('authorization=secret-value-123456', 'secret-value-123456');
  expect(text).not.toContain('secret-value-123456');
  expect(text).toContain('[REDACTED]');
});

test('Bearer 与 sk- 形式被替换', () => {
  const text = redactSecrets('Authorization: Bearer abc.def-123_456 and sk-live-abcdefghijklmnop');
  expect(text).toContain('Bearer [REDACTED]');
  expect(text).not.toContain('abc.def-123_456');
  expect(text).toContain('sk-[REDACTED]');
  expect(text).not.toContain('sk-live-abcdefghijklmnop');
});

test('JSON apiKey 字段被替换', () => {
  const text = redactSecrets(JSON.stringify({ apiKey: 'plain-key', other: 'keep' }));
  expect(text).not.toContain('plain-key');
  expect(text).toContain('[REDACTED]');
  expect(text).toContain('keep');
});
