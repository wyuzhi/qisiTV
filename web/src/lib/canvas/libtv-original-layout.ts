// Exact media geometry captured from the public LibTV read-only canvas.
// Coordinates are viewport pixels at the captured 1440x900, 10% camera.
import { libtvOriginalMediaLayoutPart1 } from "./libtv-original-layout-part1";
import { libtvOriginalMediaLayoutPart2 } from "./libtv-original-layout-part2";

export const libtvOriginalMediaLayout = [
    ...libtvOriginalMediaLayoutPart1,
    ...libtvOriginalMediaLayoutPart2,
] as const;
