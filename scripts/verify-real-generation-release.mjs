import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_PATHS = [
  'backend',
  'web',
  'agent-host',
  'plugin-packages',
  'scripts',
  'assets/app-icon.png',
  'VERSION',
  '.github/workflows',
];

const ALLOWED_RECEIPT_KEYS = new Set(['version', 'sourceDigest', 'passed', 'evidenceSha256']);
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const fail = message => {
  throw new Error(`Real generation release gate: ${message}`);
};

export function computeSourceDigest(cwd = process.cwd(), ref = 'HEAD') {
  const sourceTree = execFileSync('git', ['ls-tree', '-r', ref, '--', ...SOURCE_PATHS], {
    cwd,
    encoding: 'utf8',
  });
  return createHash('sha256').update(sourceTree).digest('hex');
}

export function validateReleaseReceipt(
  receipt,
  {
    expectedVersion,
    expectedSourceDigest,
    requireSourceDigestMatch = true,
    fullEvidenceBytes,
  } = {},
) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('receipt must be a JSON object');
  }
  const keys = Object.keys(receipt);
  for (const key of keys) {
    if (!ALLOWED_RECEIPT_KEYS.has(key)) {
      fail(`receipt contains disallowed internal field: ${key}`);
    }
  }
  for (const requiredKey of ALLOWED_RECEIPT_KEYS) {
    if (!(requiredKey in receipt)) {
      fail(`receipt is missing required field: ${requiredKey}`);
    }
  }
  if (typeof receipt.version !== 'string' || !VERSION_PATTERN.test(receipt.version)) {
    fail('receipt version must match v<major>.<minor>.<patch>');
  }
  if (expectedVersion && receipt.version !== expectedVersion) {
    fail(`receipt version ${receipt.version} does not match VERSION ${expectedVersion}`);
  }
  if (typeof receipt.sourceDigest !== 'string' || !SHA256_PATTERN.test(receipt.sourceDigest)) {
    fail('receipt sourceDigest must be a 64-character lowercase hex sha256');
  }
  if (requireSourceDigestMatch && expectedSourceDigest && receipt.sourceDigest !== expectedSourceDigest) {
    fail('receipt does not match this release source');
  }
  if (receipt.passed !== true) {
    fail('receipt passed must be true');
  }
  if (typeof receipt.evidenceSha256 !== 'string' || !SHA256_PATTERN.test(receipt.evidenceSha256)) {
    fail('receipt evidenceSha256 must be a 64-character lowercase hex sha256');
  }
  if (fullEvidenceBytes !== undefined) {
    const actualSha256 = createHash('sha256').update(fullEvidenceBytes).digest('hex');
    if (actualSha256 !== receipt.evidenceSha256) {
      fail('receipt evidenceSha256 does not match full evidence file');
    }
  }
  return true;
}

export function normalizeVersion(rawVersion) {
  return `v${String(rawVersion || '').trim().replace(/^v/, '')}`;
}

export function verifyReleaseEvidenceDirectory(cwd = process.cwd(), expectedVersion) {
  const dir = join(cwd, 'docs', 'release-evidence');
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail('docs/release-evidence directory is missing');
  }
  const normalizedVersion = normalizeVersion(expectedVersion);
  const receiptFile = `${normalizedVersion}.json`;
  for (const entry of entries) {
    if (!/^v\d+\.\d+\.\d+\.json$/.test(entry)) {
      fail(`disallowed internal file in docs/release-evidence: ${entry}`);
    }
    if (entry !== receiptFile) {
      fail(`docs/release-evidence must contain only ${receiptFile} (found extra receipt: ${entry})`);
    }
  }
  if (entries.length !== 1 || entries[0] !== receiptFile) {
    fail(`missing minimal release receipt docs/release-evidence/${receiptFile}`);
  }
  if (!statSync(join(dir, receiptFile)).isFile()) {
    fail(`release receipt docs/release-evidence/${receiptFile} must be a regular file`);
  }
}

export function runReleaseGate({
  cwd = process.cwd(),
  argv = process.argv.slice(2),
} = {}) {
  const refFlagIndex = argv.indexOf('--ref');
  const ref = refFlagIndex >= 0 ? argv[refFlagIndex + 1] : 'HEAD';
  if (refFlagIndex >= 0 && !ref) {
    fail('--ref requires a git revision');
  }
  const sourceDigest = computeSourceDigest(cwd, ref);
  if (argv.includes('--fingerprint')) {
    console.log(sourceDigest);
    return { mode: 'fingerprint', sourceDigest };
  }
  const dryRun = argv.includes('--dry-run');
  const evidenceFlagIndex = argv.indexOf('--evidence-file');
  const evidenceFile = evidenceFlagIndex >= 0 ? argv[evidenceFlagIndex + 1] : undefined;
  if (evidenceFlagIndex >= 0 && !evidenceFile) {
    fail('--evidence-file requires a path');
  }

  const version = normalizeVersion(readFileSync(join(cwd, 'VERSION'), 'utf8'));
  verifyReleaseEvidenceDirectory(cwd, version);
  const receiptPath = join(cwd, 'docs', 'release-evidence', `${version}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const fullEvidenceBytes = evidenceFile ? readFileSync(evidenceFile) : undefined;

  validateReleaseReceipt(receipt, {
    expectedVersion: version,
    expectedSourceDigest: sourceDigest,
    requireSourceDigestMatch: !dryRun,
    fullEvidenceBytes,
  });

  console.log(
    dryRun
      ? `${version} minimal release receipt dry-run passed (sourceDigest=${receipt.sourceDigest}, evidenceSha256=${receipt.evidenceSha256}).`
      : `${version} minimal release receipt verified (sourceDigest=${receipt.sourceDigest}, evidenceSha256=${receipt.evidenceSha256}).`,
  );
  return { mode: dryRun ? 'dry-run' : 'release', version, receipt };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runReleaseGate();
}
