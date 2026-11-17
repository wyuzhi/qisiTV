import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const auditScript = fileURLToPath(new URL("./audit-third-party-notices.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const MIT_GRANT = [
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'The above copyright notice and this permission notice shall be included in all',
].join("\n");

function makeMinimalFixture(t) {
    const root = mkdtempSync(resolve(tmpdir(), "beeftv-tpn-audit-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of [
        "web/public/mediapipe/wasm",
        "web/public/three/basis",
        "web/public/canvas/models",
        "web/public/welcome",
        "web/src/lib/canvas",
        "agent-host",
        "backend/internal/skills/seed",
        "plugin-packages/runway-video",
        "plugin-packages/luma-dream-machine",
        "plugin-packages/autodl-comfyui",
        "plugins/beeftv-skills",
    ]) {
        mkdirSync(resolve(root, dir), { recursive: true });
    }
    writeFileSync(resolve(root, "web/package.json"), JSON.stringify({ dependencies: { react: "19.0.0" } }));
    writeFileSync(resolve(root, "agent-host/package.json"), JSON.stringify({ dependencies: { "@earendil-works/pi-ai": "1.5.0" } }));
    writeFileSync(resolve(root, "backend/go.mod"), "module example.com/test\n\ngo 1.26.0\n\nrequire github.com/gin-gonic/gin v1.12.0\nrequire golang.org/x/sys v0.49.0 // indirect\n");
    writeFileSync(resolve(root, "web/public/canvas/models/facecap.glb"), "glb");
    writeFileSync(resolve(root, "web/public/welcome/credits.html"), "<html></html>");
    writeFileSync(resolve(root, "web/src/lib/canvas/camera-prompt-library.ts"), "// ported");
    writeFileSync(
        resolve(root, "plugin-packages/runway-video/LICENSE"),
        `https://github.com/BerriAI/litellm\nCopyright (c) 2023 Berri AI\n\n${MIT_GRANT}\n`,
    );
    writeFileSync(resolve(root, "plugin-packages/runway-video/manifest.json"), JSON.stringify({ author: "影策 / Open AI Canvas contributors" }));
    writeFileSync(resolve(root, "plugin-packages/runway-video/README.md"), "源自影策 Open AI Canvas 社区");
    writeFileSync(resolve(root, "plugin-packages/luma-dream-machine/manifest.json"), JSON.stringify({ author: "影策 / Open AI Canvas contributors" }));
    writeFileSync(resolve(root, "plugin-packages/luma-dream-machine/README.md"), "源自影策 Open AI Canvas 社区");
    writeFileSync(resolve(root, "plugin-packages/autodl-comfyui/manifest.json"), JSON.stringify({ author: "BeefTV Contributors" }));
    writeFileSync(
        resolve(root, "LICENSE"),
        [
            "Copyright (c) 2026 basketikun",
            "Copyright (c) 2026 ddcat and Open AI Canvas contributors",
            MIT_GRANT,
            "Open Storyboard Canvas additions:",
            "Copyright (c) 2026 ganbo-gab and contributors",
            "Storyboard-Copilot by henjicc / 痕继痕迹",
            "https://github.com/henjicc/Storyboard-Copilot",
            "See NOTICE and",
            "docs/legal/upstream-author-authorization-2026-05-31.jpg for the attribution",
            "The MIT terms below apply to the new original code and resources in this",
            'Permission is hereby granted, free of charge, to any person obtaining a copy',
            "The above copyright notice, this permission notice, and the original project",
        ].join("\n"),
    );
    writeFileSync(
        resolve(root, "NOTICE"),
        [
            "https://github.com/basketikun/infinite-canvas",
            "568f0f1838df8de31fe885a4e130e2f346dd14ab",
            "https://github.com/ddcat-ai/open-ai-canvas",
            "b7484c56789a7cf1ea7c062084d56af5c3dd18cd",
            "https://github.com/ganbo-gab/open-storyboard-canvas",
            "b7b05ff920b830b0e97744757ef0e41e956bb4e3",
            "https://github.com/henjicc/Storyboard-Copilot",
        ].join("\n"),
    );
    writeFileSync(
        resolve(root, "plugins/beeftv-skills/LICENSE"),
        `Copyright (c) 2026 basketikun\nCopyright (c) 2026 ddcat and Open AI Canvas contributors\n\n${MIT_GRANT}\n`,
    );
    writeFileSync(
        resolve(root, "backend/internal/skills/seed/skills.json"),
        JSON.stringify([{ skill_id: "s1", effective_user: { name: "BeefTV 官方", avatar_url: "" }, showcase_media: [] }]),
    );
    writeFileSync(
        resolve(root, "THIRD_PARTY_NOTICES.md"),
        [
            "`react`",
            "`@earendil-works/pi-ai`",
            "`github.com/gin-gonic/gin`",
            "`web/public/mediapipe/wasm/*`",
            "`web/public/three/basis/*`",
            "`web/public/canvas/models/facecap.glb`",
            "`web/public/welcome/credits.html`",
            "`web/src/lib/canvas/camera-prompt-library.ts`",
            "`plugin-packages/runway-video/LICENSE`",
        ].join("\n"),
    );
    return root;
}

test("passes on the live repository and on a compliant minimal fixture", (t) => {
    execFileSync("sh", [auditScript, repoRoot], { stdio: "pipe" });
    const root = makeMinimalFixture(t);
    execFileSync("sh", [auditScript, root], { stdio: "pipe" });
});

test("rejects truncated ddcat copyright, unindexed models, overwritten protocol authors, and external seed CDN links", (t) => {
    {
        const root = makeMinimalFixture(t);
        writeFileSync(resolve(root, "plugins/beeftv-skills/LICENSE"), `Copyright (c) 2026 basketikun\nCopyright (c) 2026 ddcat\n\n${MIT_GRANT}\n`);
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /missing required license|truncated upstream Open AI Canvas/);
    }
    {
        const root = makeMinimalFixture(t);
        mkdirSync(resolve(root, "plugins/extra"), { recursive: true });
        writeFileSync(resolve(root, "plugins/extra/LICENSE"), "Copyright (c) 2026 ddcat\n");
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /truncated upstream Open AI Canvas/);
    }
    {
        const root = makeMinimalFixture(t);
        writeFileSync(resolve(root, "web/public/canvas/models/new-model.onnx"), "onnx");
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /new-model\.onnx/);
    }
    {
        const root = makeMinimalFixture(t);
        writeFileSync(resolve(root, "plugin-packages/luma-dream-machine/manifest.json"), JSON.stringify({ author: "BeefTV Contributors" }));
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /luma-dream-machine/);
    }
    {
        const root = makeMinimalFixture(t);
        writeFileSync(
            resolve(root, "backend/internal/skills/seed/skills.json"),
            JSON.stringify([{ skill_id: "s1", effective_user: { name: "x", avatar_url: "https://p3-faceu-img-sign.byteimg.com/a.png" }, showcase_media: [] }]),
        );
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /CDN URLs/);
    }
});

test("rejects missing NOTICE or truncated verbatim license bodies in LICENSE and sub-package notices", (t) => {
    {
        const root = makeMinimalFixture(t);
        unlinkSync(resolve(root, "NOTICE"));
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }));
    }
    {
        const root = makeMinimalFixture(t);
        writeFileSync(
            resolve(root, "LICENSE"),
            `Copyright (c) 2026 basketikun\nCopyright (c) 2026 ddcat and Open AI Canvas contributors\n\n${MIT_GRANT}\n`,
        );
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /Open Storyboard Canvas additions/);
    }
    {
        const root = makeMinimalFixture(t);
        writeFileSync(resolve(root, "plugin-packages/runway-video/LICENSE"), "MIT\n");
        assert.throws(() => execFileSync("sh", [auditScript, root], { stdio: "pipe" }), /runway-video\/LICENSE/);
    }
});
