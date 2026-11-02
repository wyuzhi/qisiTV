type VideoContract = {
    models: string[];
    allowSuffix: boolean;
    protocol: string;
    inlineMedia: boolean;
    requiresHTTPReferences?: boolean;
    // An omitted kind keeps the model's existing capability limit, matching Go.
    maxReferences?: Partial<Record<"image" | "video" | "audio", number>>;
    operations?: string[];
    resolutions?: string[];
    referenceResolution?: string;
    ratios?: string[];
    duration?: { min: number; max: number; default: number };
    maxImageDuration?: number;
    generateAudio?: boolean;
};

const contracts: VideoContract[] = [
    {
        models: ["grok-imagine-video-1.5"],
        allowSuffix: false,
        protocol: "newapi",
        inlineMedia: true,
        maxReferences: { image: 1, video: 0, audio: 0 },
        operations: ["text_to_video", "image_to_video"],
        resolutions: ["480p", "720p", "1080p"],
        referenceResolution: "720p",
        ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
        duration: { min: 1, max: 15, default: 6 },
        maxImageDuration: 10,
        generateAudio: true,
    },
    {
        models: ["kling-video-v3"],
        allowSuffix: false,
        protocol: "newapi",
        inlineMedia: true,
        maxReferences: { image: 1, video: 0, audio: 0 },
        operations: ["text_to_video", "image_to_video"],
        resolutions: ["720p"],
        ratios: ["16:9", "9:16", "1:1"],
        duration: { min: 3, max: 15, default: 5 },
        generateAudio: true,
    },
    {
        models: ["minimax-h3-max-turbo", "minimax-h3-max"],
        allowSuffix: false,
        protocol: "newapi-channel-2",
        inlineMedia: true,
        maxReferences: { image: 9, video: 3, audio: 3 },
        operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video"],
    },
    {
        models: ["minimax-h3"],
        allowSuffix: false,
        protocol: "newapi-channel-2",
        inlineMedia: true,
        maxReferences: { image: 9, video: 3, audio: 3 },
        operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video"],
    },
    {
        models: ["minimax-h3-max-style-hand-drawn", "minimax-h3-max-style-16bit-pixel", "minimax-h3-max-style-low-poly", "minimax-h3-max-style-retro-toon-70s", "minimax-h3-max-style-vhs"],
        allowSuffix: false,
        protocol: "newapi-channel-2",
        inlineMedia: true,
        maxReferences: { image: 1, video: 0, audio: 0 },
        operations: ["text_to_video", "image_to_video"],
        resolutions: ["768p"],
        ratios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"],
        duration: { min: 5, max: 15, default: 5 },
    },
    {
        models: ["seedance-2.0", "seedance-2.5"],
        allowSuffix: true,
        protocol: "newapi",
        inlineMedia: true,
    },
    {
        models: ["wan3.0-video", "wan3.0", "wan3"],
        allowSuffix: false,
        protocol: "newapi-channel-2",
        inlineMedia: false,
        requiresHTTPReferences: true,
        maxReferences: { image: 1, video: 0, audio: 0 },
        operations: ["text_to_video", "image_to_video"],
    },
];

export function isBeefAPIEndpoint(baseUrl: string): boolean {
    try {
        const url = new URL(baseUrl.trim());
        return url.protocol === "https:" && ["beeftv.app", "enterprise.beefapi.com"].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443");
    } catch { return false; }
}

export function beefAPIVideoContract(model: string): VideoContract | undefined {
    const name = model.trim().toLowerCase();
    return contracts.find((contract) => contract.models.some((prefix) => name === prefix || (contract.allowSuffix && name.startsWith(`${prefix}-`))));
}
