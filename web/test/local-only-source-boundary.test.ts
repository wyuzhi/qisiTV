import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const srcRoot = resolve(root, "src");

function walkSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkSourceFiles(path));
            continue;
        }
        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(path);
    }
    return files;
}

describe("local-only source boundary", () => {
    test("hosted UI and API entrypoints are physically absent", () => {
        for (const path of [
            "src/services/api/auth.ts",
            "src/services/api/wallet.ts",
            "src/services/api/announcements.ts",
            "src/services/user-data-sync.ts",
            "src/pages/auth/login.tsx",
            "src/pages/admin/index.tsx",
			"src/lib/model-pricing.ts",
			"src/constant/credits.tsx",
			"src/pages/settings/channel-video-pricing.tsx",
			"src/components/canvas/canvas-share-modal.tsx",
			"src/pages/canvas/shared.tsx",
			"src/services/api/canvas-share.ts",
			"src/welcome-application.tsx",
			"src/services/api/welcome.ts",
			"src/services/api/channel-order.ts",
			"src/services/api/response-interception.ts",
			"src/services/api/system-update.ts",
			"src/styles/admin-ui.css",
        ]) expect(existsSync(resolve(root, path))).toBe(false);
    });

    test("workspace startup depends only on the local contract", () => {
        const session = readFileSync(resolve(root, "src/lib/user-session.ts"), "utf8");
        const sync = readFileSync(resolve(root, "src/services/local-workspace-sync.ts"), "utf8");
        expect(session).not.toMatch(/auth\/session|remote user|cloud/i);
        expect(sync).not.toMatch(/getRemote|upsertRemote|remoteUserDataPhase|activeRemoteUserId/);
        expect(sync).toContain("flushCanvasStorePersistence");
        expect(sync).toContain("flushAssetStorePersistence");
    });

    test("desktop runtime contains no commerce compatibility state", () => {
        const files = [
            "src/services/workspace-mode.ts",
            "src/stores/use-user-store.ts",
            "src/services/api/creation-runs.ts",
            "src/services/api/task-center.ts",
        ];
        for (const file of files) {
            const source = readFileSync(resolve(root, file), "utf8");
            expect(source).not.toMatch(/billing|creditsEnabled|waiting_payment|pendingPayment|wallet:updated|amountMicrocredits/i);
        }
    });

	test("local model configuration contains capabilities, not commerce metadata", () => {
		for (const file of [
			"src/stores/use-config-store.ts",
			"src/services/api/logical-models.ts",
			"src/components/model-picker.tsx",
			"src/components/image-settings-panel.tsx",
			"src/components/video-settings-panel.tsx",
		]) {
			const source = readFileSync(resolve(root, file), "utf8");
			expect(source).not.toMatch(/billing|microcredits|priceTier|pricePolicy|quoteLogical|showSelectedPrice|showOptionPrices|bypassPriceGuard/i);
		}
	});

	test("production API clients expose no hosted admin endpoints", () => {
		for (const file of ["src/services/api/appearance.ts", "src/pages/plugins/index.tsx"]) {
			const source = readFileSync(resolve(root, file), "utf8");
			expect(source).not.toMatch(/\/admin\//);
		}
	});

	test("frontend source files do not import across into backend/", () => {
		const offenders = walkSourceFiles(srcRoot)
			.filter((file) => /(?:from|import)\s*["'\(][^"'\)]*backend\//.test(readFileSync(file, "utf8")))
			.map((file) => relative(srcRoot, file));
		expect(offenders).toEqual([]);
	});

	test("frontend source files do not display BeefAPI brand in user-facing string literals", () => {
		const offenders: string[] = [];
		for (const file of walkSourceFiles(srcRoot)) {
			const literals = readFileSync(file, "utf8").match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
			if (literals.some((lit) => /BeefAPI/.test(lit.replace(/\$\{[^}]*\}/g, "")) && !lit.includes("BeefAPIConnectionChangedError"))) {
				offenders.push(relative(srcRoot, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
