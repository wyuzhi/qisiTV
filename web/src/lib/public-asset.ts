/** Bundled resources also work when the canvas lives below a website path. */
export function publicAssetUrl(path: string) {
    return `${import.meta.env.BASE_URL || "/"}${path.replace(/^\/+/, "")}`;
}
