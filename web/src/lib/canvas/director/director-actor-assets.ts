import type { DirectorActorPresetId } from "@/types/director";
import { publicAssetUrl } from "@/lib/public-asset";

const MALE_PATH = "canvas/models/quaternius-standard-male.glb";
const FEMALE_PATH = "canvas/models/quaternius-standard-female.glb";
export const DIRECTOR_QUATERNIUS_MALE_URL = publicAssetUrl(MALE_PATH);
export const DIRECTOR_QUATERNIUS_FEMALE_URL = publicAssetUrl(FEMALE_PATH);

/** Saved bundled actors can move between the desktop root and the website base. */
export function resolveDirectorBundledActorUrl(url?: string): string | null {
    for (const [path, currentUrl] of [[MALE_PATH, DIRECTOR_QUATERNIUS_MALE_URL], [FEMALE_PATH, DIRECTOR_QUATERNIUS_FEMALE_URL]]) {
        if (url === currentUrl || url === `/${path}` || url === `/qisitv/${path}`) return currentUrl;
    }
    return null;
}

/** Resolve both new presets and URL-less older actors to the bundled rigged bases. */
export function resolveDirectorBuiltInActorUrl(preset?: DirectorActorPresetId): string | null {
    if (preset === "standard_female") return DIRECTOR_QUATERNIUS_FEMALE_URL;
    if (preset === "geometric") return null;
    return DIRECTOR_QUATERNIUS_MALE_URL;
}
