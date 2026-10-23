import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const base of [undefined, "/qisitv/"]) {
    test(`bundled director URLs load with ${base || "an undefined build base"}`, () => {
        const env = { ...process.env };
        if (base) env.BASE_URL = base;
        else delete env.BASE_URL;
        const run = Bun.spawnSync([process.execPath, "--eval", `
            import { DIRECTOR_QUATERNIUS_MALE_URL, DIRECTOR_QUATERNIUS_FEMALE_URL, resolveDirectorBundledActorUrl } from "./src/lib/canvas/director/director-actor-assets";
            import { DIRECTOR_REPRO_LOCAL_MODEL_URL, DIRECTOR_REPRO_ANIMATED_PERSON_URL } from "./src/lib/canvas/director/director-repro-fixture";
            console.log(JSON.stringify({
                urls: [DIRECTOR_QUATERNIUS_MALE_URL, DIRECTOR_QUATERNIUS_FEMALE_URL, DIRECTOR_REPRO_LOCAL_MODEL_URL, DIRECTOR_REPRO_ANIMATED_PERSON_URL],
                legacy: resolveDirectorBundledActorUrl("/canvas/models/quaternius-standard-male.glb"),
                website: resolveDirectorBundledActorUrl("/qisitv/canvas/models/quaternius-standard-male.glb"),
                custom: resolveDirectorBundledActorUrl("https://example.com/canvas/models/quaternius-standard-male.glb"),
            }));
        `], { cwd: fileURLToPath(new URL("../", import.meta.url)), env });
        expect(run.exitCode).toBe(0);
        const result = JSON.parse(run.stdout.toString());
        const prefix = `${base || "/"}canvas/models/`;
        expect(result.urls).toEqual([
            `${prefix}quaternius-standard-male.glb`,
            `${prefix}quaternius-standard-female.glb`,
            `${prefix}director-repro-triangle.gltf`,
            `${prefix}director-repro-animated-person.gltf`,
        ]);
        expect(result.legacy).toBe(result.urls[0]);
        expect(result.website).toBe(result.urls[0]);
        expect(result.custom).toBeNull();
    });
}
