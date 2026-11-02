#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

for private_path in \
  docs/adr \
  docs/superpowers \
  docs/audits \
  docs/visual-regression \
  docs/public-release/internal-backup-manifest.md \
  docs/content/docs/progress \
  docs/refactor \
  docs/evidence \
  docs/review-evidence \
  docs/research \
  docs/architecture \
  docs/reports \
  docs/plans \
  docs/implementation \
  docs/ops \
  reviews \
  docs/agent-branch-testing.md \
  docs/fal-h3-family.md \
  docs/fal-h3-full-capabilities.md \
  docs/fal-h3-max-turbo.md \
  docs/model-provider-validation.md \
  docs/real-generation-release.md \
  docs/security-guardrail-audit.md \
  docs/topaz-fal-integration-report-2026-10-20.md \
  docs/windows-upgrade-compatibility.md
do
  if [ -e "$private_path" ]; then
    echo "internal documentation leaked into public tree: $private_path" >&2
    exit 1
  fi
done

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import {
  normalizeVersion,
  validateReleaseReceipt,
  verifyReleaseEvidenceDirectory,
} from "./scripts/verify-real-generation-release.mjs";

const roots = [
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "QUICKSTART.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "docs",
  "web/src/components/ui/README.md",
];

const allowedRootDocs = new Set([
  "docs/index.md",
  "docs/desktop-install.md",
  "docs/linux-install.md",
  "docs/desktop-local-development.md",
  "docs/desktop-release.md",
  "docs/local-first-architecture.md",
  "docs/local-model-config-persistence.md",
  "docs/local-workspace-data-sources.md",
  "docs/media-source-distribution.md",
  "docs/storage-settings.md",
  "docs/upstream-maintenance.md",
]);

const isQisiTV = JSON.parse(fs.readFileSync("web/package.json", "utf8")).name === "qisitv";
const qisiDesignDocs = new Set([
  "project-folders-and-agent.md",
  "likeai-engine-integration.md",
  "web-engine-contract.md",
  "web-feature-parity.md",
]);
if (fs.existsSync("docs/design")) {
  for (const entry of fs.readdirSync("docs/design", { withFileTypes: true })) {
    if (!isQisiTV || !entry.isFile() || !qisiDesignDocs.has(entry.name)) {
      console.error(`internal documentation leaked into public tree: docs/design/${entry.name}`);
      process.exit(1);
    }
  }
}

if (!fs.existsSync("docs/index.md")) {
  console.error("missing required public documentation index: docs/index.md");
  process.exit(1);
}

for (const entry of fs.readdirSync("docs", { withFileTypes: true })) {
  if (entry.isFile() && /\.(?:md|mdx)$/i.test(entry.name)) {
    const rel = `docs/${entry.name}`;
    if (!allowedRootDocs.has(rel) && !(isQisiTV && /^upstream-sync-\d{8}\.md$/.test(entry.name))) {
      console.error(`unapproved root documentation file in docs/: ${rel}`);
      process.exit(1);
    }
  }
}

// BeefTV's receipt certifies its own paid-generation release, not this fork.
// qisiTV publishes its validation boundaries in the sync record and verifies
// its versioned engine installer separately before exporting the website.
try {
  if (!isQisiTV) {
  const currentVersion = normalizeVersion(fs.readFileSync("VERSION", "utf8"));
  verifyReleaseEvidenceDirectory(process.cwd(), currentVersion);
  const rel = `docs/release-evidence/${currentVersion}.json`;
  const data = JSON.parse(fs.readFileSync(rel, "utf8"));
  validateReleaseReceipt(data, {
    expectedVersion: currentVersion,
    requireSourceDigestMatch: false,
  });
  }
} catch (err) {
  console.error(`release receipt validation failed: ${err.message || err}`);
  process.exit(1);
}

const files = [];
function collect(entry) {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) collect(path.join(entry, child));
    return;
  }
  if (/\.(?:md|mdx|json)$/i.test(entry)) files.push(entry);
}

for (const root of roots) collect(root);

const forbiddenRules = [
  { name: "local volume path (/Volumes)", regex: /(?:^|[^A-Za-z0-9_])\/Volumes(?:\/|\b)/ },
  { name: "personal home path (/Users/...)", regex: /(?:^|[^A-Za-z0-9_])\/Users\/[A-Za-z0-9._-]+\b/ },
  { name: "session identifier (sess_ / tds/conv-)", regex: /\bsess_[A-Za-z0-9_-]{4,}|tds\/conv-[A-Za-z0-9_-]+/ },
  { name: "Feishu table identifier (tbl...)", regex: /\btbl[A-Za-z0-9]{10,}\b/ },
  { name: "owner-authorization reference", regex: /owner-authorization/i },
  {
    name: "internal budget amount",
    regex: /(?:预算|花费|实花)\s*(?:上限\s*)?(?:[:：]\s*|(?:¥|￥|CNY\s*))\d+|(?:预算|花费|实花)\s*(?:上限\s*)?\d+(?:\.\d+)?\s*元|(?:¥|￥|CNY\s*)\d+(?:\.\d+)?\s*预算/,
  },
  {
    name: "internal/customer personal name",
    regex: new RegExp(
      `\\b(?:${["Lu" + "cas", "En" + "der", "Sun" + "ny"].join("|")})\\b|${["\\u8303\\u952e\\u4fca", "\\u8001\\u674e"].join("|")}`,
    ),
  },
];

const patternFailures = [];
const linkFailures = [];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of forbiddenRules) {
      if (rule.regex.test(line)) {
        patternFailures.push(`${file}:${idx + 1}: [${rule.name}] ${line.trim()}`);
      }
    }
  });

  if (!/\.(?:md|mdx)$/i.test(file)) continue;
  const prose = source.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
  const targets = [
    ...Array.from(prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g), (m) => m[1]),
    ...Array.from(prose.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi), (m) => m[1]),
  ];
  for (const matchTarget of targets) {
    const rawTarget = matchTarget.trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(rawTarget)) continue;
    const target = decodeURIComponent(rawTarget.split("#", 1)[0].split("?", 1)[0]);
    if (!target) continue;
    const candidates = [];
    if (target.startsWith("/docs/")) {
      const route = target.slice("/docs/".length);
      candidates.push(path.resolve("docs/content/docs", route));
    } else if (target.startsWith("/images/")) {
      candidates.push(path.resolve("docs/public", target.slice(1)));
    } else {
      candidates.push(path.resolve(path.dirname(file), target));
    }
    const expanded = candidates.flatMap((candidate) => [candidate, `${candidate}.md`, `${candidate}.mdx`]);
    if (!expanded.some((candidate) => fs.existsSync(candidate))) linkFailures.push(`${file}: ${rawTarget}`);
  }
}

if (patternFailures.length) {
  console.error("forbidden internal patterns in public documentation:\n" + patternFailures.join("\n"));
  process.exit(1);
}

if (linkFailures.length) {
  console.error("broken local documentation links:\n" + linkFailures.join("\n"));
  process.exit(1);
}

console.log(`public documentation audit passed (${files.length} files)`);
NODE
