// 所有写盘文本都从这里脱敏：上游密钥、Bearer 头和 sk- 形式密钥。
export function redactSecrets(value, secret = '') {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text === null) text = '';
  const key = String(secret || '').trim();
  if (key.length >= 4) text = text.split(key).join('[REDACTED]');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
  text = text.replace(/("(?:apiKey|api_key|authorization)"\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3');
  return text;
}
