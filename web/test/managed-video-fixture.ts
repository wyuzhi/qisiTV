import { readFileSync } from "node:fs";
import { sanitizeVideoPriceQuote } from "../src/lib/seedance-portrait";
import { sanitizeServerVideoCapability } from "../src/lib/model-capabilities";
import type { ChannelModelCatalogItem } from "../src/lib/channel-model-catalog";

// Both snapshots were emitted by BeefAPI HTTP handlers; no model-name defaults.
const snapshots = ["managed-video-catalog.json", "managed-video-catalog-live.json"].flatMap((name) => JSON.parse(readFileSync(new URL(`../../backend/internal/beefapi/testdata/${name}`, import.meta.url), "utf8")).data);
export function managedVideoCatalogItem(model: string): ChannelModelCatalogItem {
    const row = snapshots.find((item) => item.id === model && item.video_capabilities_version);
    const videoCapabilities = sanitizeServerVideoCapability(row?.video_capabilities);
    if (!row || !videoCapabilities) throw new Error(`No server video fixture for ${model}`);
    return { id: model, supportedEndpointTypes: ["openai-video"], videoCapabilities, videoCapabilitiesVersion: row.video_capabilities_version, videoPricing: sanitizeVideoPriceQuote(row.video_pricing) };
}
