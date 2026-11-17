export type CanvasImageLightingOptions = {
    azimuth: number;
    elevation: number;
    brightness: number;
    rimLight: boolean;
    stylePreset: string;
    smartMode: boolean;
    lightColor: string;
};

export const defaultLightingOptions: CanvasImageLightingOptions = {
    azimuth: 0,
    elevation: 0,
    brightness: 50,
    rimLight: false,
    stylePreset: "",
    smartMode: true,
    lightColor: "#ffffff",
};

export const LIGHT_POSITIONS = [
    { label: "左侧", azimuth: 270, elevation: 0 },
    { label: "顶部", azimuth: 0, elevation: 80 },
    { label: "右侧", azimuth: 90, elevation: 0 },
    { label: "前方", azimuth: 0, elevation: 0 },
    { label: "底部", azimuth: 0, elevation: -80 },
    { label: "后方", azimuth: 180, elevation: 0 },
];

export const STYLE_PRESETS = [
    { id: "overexposed", name: "过曝胶片", color: "#d4b896", image: "/lighting-presets/overexposed.png", prompt: "overexposed film aesthetic, high-key lighting, washed out highlights, soft diffused light, vintage film look" },
    { id: "blueBacklight", name: "蓝色逆光", color: "#1a3a5c", image: "/lighting-presets/blue-backlight.png", prompt: "dramatic backlighting, blue rim light, cool color temperature, silhouette with colored edges, ethereal atmosphere" },
    { id: "rembrandt", name: "伦勃朗光", color: "#5a3a1a", image: "/lighting-presets/rembrandt.png", prompt: "Rembrandt lighting, 45-degree angle key light, dramatic chiaroscuro, painterly shadows, classical portraiture" },
    { id: "cyberpunk", name: "赛博朋克", color: "#2a0a2a", image: "/lighting-presets/cyberpunk.png", prompt: "cyberpunk neon lighting, synthetic glow, futuristic atmosphere, vibrant cyan and magenta neon" },
    { id: "sunset", name: "落日迷幻", color: "#7a3010", image: "/lighting-presets/sunset.png", prompt: "golden hour lighting, warm sunset tones, long shadow, romantic atmosphere, Kodachrome colors" },
    { id: "mysterious", name: "神秘暗调", color: "#0a0a14", image: "/lighting-presets/mysterious.png", prompt: "low-key noir lighting, deep shadows, mysterious mood, film noir style, high contrast cinematic" },
    { id: "goldenHour", name: "黄金时刻", color: "#7a5a00", image: "/lighting-presets/golden-hour.png", prompt: "golden hour photography, warm soft light, beautiful catchlights, lens flare, magical golden glow" },
    { id: "nolanGrey", name: "诺兰冷灰", color: "#1a2a2a", image: "/lighting-presets/nolan-grey.png", prompt: "Christopher Nolan cinematography, IMAX quality, desaturated cold palette, teal and grey grading" },
];

export function buildLightingLabel(options: CanvasImageLightingOptions) {
    const preset = STYLE_PRESETS.find((item) => item.id === options.stylePreset);
    const position = LIGHT_POSITIONS.find((item) => item.azimuth === options.azimuth && item.elevation === options.elevation);
    const parts: string[] = [];
    parts.push(preset?.name || (position ? `主光${position.label}` : `主光 ${options.azimuth}°/${options.elevation}°`));
    if (options.brightness !== 50) parts.push(`亮度 ${options.brightness}%`);
    if (options.rimLight) parts.push("轮廓光");
    if (options.lightColor && options.lightColor.toLowerCase() !== "#ffffff") parts.push(`光色 ${options.lightColor}`);
    return `AI 打光：${parts.join("，")}`;
}
