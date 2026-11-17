#!/bin/sh
set -eu

root=${1:-.}
notice="$root/THIRD_PARTY_NOTICES.md"
package="$root/web/package.json"

test -f "$notice"
test -f "$root/LICENSE"
test -f "$root/NOTICE"
test -f "$package"
test -f "$root/agent-host/package.json"
test -f "$root/backend/go.mod"

go_mod_json=$(go -C "$root/backend" mod edit -json)

GO_MOD_JSON="$go_mod_json" node - "$root" "$package" "$root/agent-host/package.json" "$notice" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [root, packagePath, agentHostPkgPath, noticePath] = process.argv.slice(2);
const notice = fs.readFileSync(noticePath, "utf8");

for (const [label, p] of [["frontend", packagePath], ["agent-host", agentHostPkgPath]]) {
  const manifest = JSON.parse(fs.readFileSync(p, "utf8"));
  const missing = Object.keys(manifest.dependencies || {}).filter((name) => !notice.includes(`\`${name}\``));
  if (missing.length) {
    console.error(`direct ${label} dependencies missing from THIRD_PARTY_NOTICES.md: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const goMod = JSON.parse(process.env.GO_MOD_JSON || "{}");
const directGo = (goMod.Require || []).filter((req) => !req.Indirect).map((req) => req.Path);
const missingGo = directGo.filter((mod) => !notice.includes(`\`${mod}\``));
if (missingGo.length) {
  console.error(`direct Go dependencies missing from THIRD_PARTY_NOTICES.md: ${missingGo.join(", ")}`);
  process.exit(1);
}

// Dynamically check all model binaries/meshes under web/public/canvas/models.
const modelsDir = path.join(root, "web/public/canvas/models");
if (fs.existsSync(modelsDir)) {
  for (const name of fs.readdirSync(modelsDir)) {
    if (!/\.(?:glb|gltf|tflite|onnx|bin|safetensors)$/i.test(name)) continue;
    const rel = `web/public/canvas/models/${name}`;
    if (!notice.includes(`\`${rel}\``)) {
      console.error(`bundled model missing from THIRD_PARTY_NOTICES.md: ${rel}`);
      process.exit(1);
    }
  }
}

// Check bundled runtime paths and sub-directory notices.
const requiredPaths = [
  "web/public/mediapipe/wasm",
  "web/public/three/basis",
  "web/public/welcome/credits.html",
  "web/src/lib/canvas/camera-prompt-library.ts",
  "plugin-packages/runway-video/LICENSE",
];
for (const rel of requiredPaths) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`required third-party notice target missing on disk: ${rel}`);
    process.exit(1);
  }
  if (!notice.includes(`\`${rel}`)) {
    console.error(`third-party asset or sub-notice missing from THIRD_PARTY_NOTICES.md: ${rel}`);
    process.exit(1);
  }
}

// Verify verbatim license bodies and attribution notices in root LICENSE, NOTICE, and sub-package notices.
const requiredContentChecks = [
  [
    "LICENSE",
    [
      "Copyright (c) 2026 basketikun",
      "Copyright (c) 2026 ddcat and Open AI Canvas contributors",
      "Open Storyboard Canvas additions:",
      "Copyright (c) 2026 ganbo-gab and contributors",
      "Storyboard-Copilot by henjicc / 痕继痕迹",
      "https://github.com/henjicc/Storyboard-Copilot",
      "See NOTICE and",
      "docs/legal/upstream-author-authorization-2026-05-31.jpg for the attribution",
      "The MIT terms below apply to the new original code and resources in this",
      "The above copyright notice, this permission notice, and the original project",
    ],
  ],
  [
    "NOTICE",
    [
      "https://github.com/basketikun/infinite-canvas",
      "568f0f1838df8de31fe885a4e130e2f346dd14ab",
      "https://github.com/ddcat-ai/open-ai-canvas",
      "b7484c56789a7cf1ea7c062084d56af5c3dd18cd",
      "https://github.com/ganbo-gab/open-storyboard-canvas",
      "b7b05ff920b830b0e97744757ef0e41e956bb4e3",
      "https://github.com/henjicc/Storyboard-Copilot",
    ],
  ],
  [
    "plugins/beeftv-skills/LICENSE",
    [
      "Copyright (c) 2026 basketikun",
      "Copyright (c) 2026 ddcat and Open AI Canvas contributors",
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      "The above copyright notice and this permission notice shall be included in all",
    ],
  ],
  [
    "plugin-packages/runway-video/LICENSE",
    [
      "https://github.com/BerriAI/litellm",
      "Copyright (c) 2023 Berri AI",
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
      "The above copyright notice and this permission notice shall be included in all",
    ],
  ],
];
for (const [rel, needles] of requiredContentChecks) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`required license/notice file missing on disk: ${rel}`);
    process.exit(1);
  }
  const body = fs.readFileSync(full, "utf8");
  for (const needle of needles) {
    if (!body.includes(needle)) {
      console.error(`missing required license/attribution text in ${rel}: ${needle}`);
      process.exit(1);
    }
  }
}

// Check all LICENSE files across the repository (excluding node_modules and .git) for truncated ddcat copyright or missing MIT grant.
function walkLicenses(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".local") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLicenses(full);
    } else if (/^LICENSE(?:\..+)?$/i.test(entry.name)) {
      const content = fs.readFileSync(full, "utf8");
      if (/^Copyright \(c\) \d+ ddcat\s*$/m.test(content)) {
        console.error(`truncated upstream Open AI Canvas copyright notice in ${path.relative(root, full)}`);
        process.exit(1);
      }
      if (content.includes("ddcat") && !content.includes("Permission is hereby granted, free of charge")) {
        console.error(`incomplete MIT permission grant in ${path.relative(root, full)}`);
        process.exit(1);
      }
    }
  }
}
walkLicenses(root);

// Audit declarative protocol packages under plugin-packages/*/manifest.json.
const beeftvOnlyProtocols = new Set([
  "autodl-comfyui",
  "full-video",
  "gemini-openai-compat",
  "video-generations-json",
]);
const pluginPkgsDir = path.join(root, "plugin-packages");
if (fs.existsSync(pluginPkgsDir)) {
  for (const entry of fs.readdirSync(pluginPkgsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginPkgsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    if (beeftvOnlyProtocols.has(entry.name)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.author !== "影策 / Open AI Canvas contributors") {
      console.error(`upstream protocol package ${entry.name} lost upstream author attribution: ${manifest.author}`);
      process.exit(1);
    }
    const readmePath = path.join(pluginPkgsDir, entry.name, "README.md");
    if (fs.existsSync(readmePath)) {
      const readme = fs.readFileSync(readmePath, "utf8");
      if (!readme.includes("影策 Open AI Canvas")) {
        console.error(`upstream protocol package ${entry.name}/README.md missing 影策 Open AI Canvas attribution`);
        process.exit(1);
      }
    }
  }
}

// Audit builtin skills seed file for unlicensed external CDN links or leftover external avatars/media.
const seedSkillsPath = path.join(root, "backend/internal/skills/seed/skills.json");
if (fs.existsSync(seedSkillsPath)) {
  const rawSeed = fs.readFileSync(seedSkillsPath, "utf8");
  if (/byteimg\.com|byteacctimg\.com|vlabvod\.com/i.test(rawSeed)) {
    console.error("seed/skills.json contains external platform CDN URLs");
    process.exit(1);
  }
  const seeds = JSON.parse(rawSeed);
  for (const item of seeds) {
    if ((item.effective_user && item.effective_user.avatar_url) || (Array.isArray(item.showcase_media) && item.showcase_media.length > 0)) {
      console.error(`seed/skills.json entry ${item.skill_id} retains external avatar_url or showcase_media`);
      process.exit(1);
    }
  }
}
NODE

if find "$root" -path '*/node_modules' -prune -o -iname '*tldraw*' -print | grep -q .; then
  echo "tldraw residue remains in the public source snapshot" >&2
  exit 1
fi

echo "third-party notice audit passed: $root"
