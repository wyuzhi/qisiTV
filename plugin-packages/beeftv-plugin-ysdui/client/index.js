// BeefTV 内置插件：银盛云枢壹算 (OneAxis) 算力与多模态渠道（beeftv-plugin-ysdui）
// 通过 app.settings 插槽提供一键 BYOK 配置面板，将银盛云枢壹算 API Key 与预置协议模型一键同步至宿主「设置 -> 模型服务」。

export const DEFAULT_BASE_URL = "https://tokenhub.ysdui.cn";
export const YSDUI_CHANNEL_ID = "ysdui";
export const YSDUI_CHANNEL_NAME = "银盛云枢壹算";

const DEFAULT_VIDEO_REFERENCES = {
  promptMaxChars: 2000,
  minImages: 0,
  maxImages: 9,
  maxImageBytes: 20 * 1024 * 1024,
  minImageWidth: 0,
  maxImageWidth: 0,
  minImageHeight: 0,
  maxImageHeight: 0,
  minImageAspectRatio: 0,
  maxImageAspectRatio: 0,
  minImagePixels: 0,
  maxImagePixels: 0,
  maxVideos: 3,
  maxVideoBytes: 20 * 1024 * 1024,
  minVideoDurationSeconds: 0,
  maxVideoDurationSeconds: 15,
  maxVideoTotalDurationSeconds: 0,
  minVideoWidth: 0,
  maxVideoWidth: 0,
  minVideoHeight: 0,
  maxVideoHeight: 0,
  minVideoAspectRatio: 0,
  maxVideoAspectRatio: 0,
  minVideoPixels: 0,
  maxVideoPixels: 0,
  minVideoFps: 0,
  maxVideoFps: 0,
  maxAudios: 3,
  maxAudioBytes: 15 * 1024 * 1024,
  minAudioDurationSeconds: 0,
  maxAudioDurationSeconds: 15,
  maxAudioTotalDurationSeconds: 0,
  maxTotalReferences: 0,
};

function createTextCapability(thinking = false) {
  return {
    version: 1,
    text: {
      references: {
        promptMaxChars: 32000,
        maxImages: 0,
        maxImageBytes: 0,
        maxVideos: 0,
        maxVideoBytes: 0,
      },
      streaming: true,
      thinking,
    },
  };
}

const IMAGE_2K_SIZES = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
  "2048x2048",
  "2560x1440",
  "1440x2560",
  "2304x1728",
  "1728x2304",
  "2496x1664",
  "1664x2496",
  "3024x1296",
];

const IMAGE_1K_2K_SIZES = [
  ...IMAGE_2K_SIZES,
  "1024x1024",
  "1280x720",
  "720x1280",
  "1152x864",
  "864x1152",
  "1248x832",
  "832x1248",
  "1512x648",
];

const WAND_VEGA_IMAGE_SIZES = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
  "1024x1024",
  "1824x1024",
  "1024x1824",
  "1360x1024",
  "1024x1360",
  "1536x1024",
  "1024x1536",
  "2352x1008",
  "2048x2048",
  "3648x2048",
  "2048x3648",
  "2720x2048",
  "2048x2720",
  "3072x2048",
  "2048x3072",
  "4704x2016",
  "4096x4096",
  "5472x3072",
  "3072x5472",
  "4800x3600",
  "3600x4800",
  "5472x3648",
  "3648x5472",
  "6720x2880",
];

export const YSDUI_PRESET_MODELS = [
  // ── 文本模型 (POST /v1/chat/completions) ──
  {
    model: "deepseek-v4.1-flash-1017",
    displayName: "DeepSeek V4.1 Flash (1017)",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "deepseek-v4-pro-0813",
    displayName: "DeepSeek V4 Pro",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "qwen3.8-max",
    displayName: "Qwen 3.8 Max",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "qwen3.8-flash",
    displayName: "Qwen 3.8 Flash",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "qwen3.7-max",
    displayName: "Qwen 3.7 Max",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "qwen3.7-plus",
    displayName: "Qwen 3.7 Plus",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "glm-5.3",
    displayName: "GLM-5.3",
    family: "GLM 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "glm-5.3-flash",
    displayName: "GLM-5.3 Flash",
    family: "GLM 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "kimi-k3",
    displayName: "Kimi K3",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "kimi-k2.6",
    displayName: "Kimi K2.6",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "minimax-m3",
    displayName: "MiniMax M3",
    family: "MiniMax 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },
  {
    model: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    family: "MiniMax 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability(true),
  },

  // ── 同步图像模型 (POST /v1/images/generations) ──
  {
    model: "doubao-seedream-5-0-260128",
    displayName: "Doubao Seedream 5.0 Lite",
    family: "Seedream 5.0",
    capability: "image",
    protocol: "ysdui-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 14,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: IMAGE_2K_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["2k"],
          default: "2k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: true, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 15,
      },
    },
  },
  {
    model: "doubao-seedream-5-0-pro-260628",
    displayName: "Doubao Seedream 5.0 Pro",
    family: "Seedream 5.0",
    capability: "image",
    protocol: "ysdui-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 14,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: IMAGE_2K_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["2k"],
          default: "2k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: true, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 15,
      },
    },
  },
  {
    model: "qwen-image-3.0-pro",
    displayName: "Qwen Image 3.0 Pro",
    family: "Qwen Image",
    capability: "image",
    protocol: "ysdui-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 3,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: IMAGE_1K_2K_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["1k", "2k"],
          default: "1k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 6,
      },
    },
  },
  {
    model: "hy-image-v3.0",
    displayName: "混元 Image 3.0",
    family: "混元 Image",
    capability: "image",
    protocol: "ysdui-image",
    endpoint: "POST /v1/images/generations",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 0,
          maxImageBytes: 0,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: IMAGE_1K_2K_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["1k", "2k"],
          default: "1k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 4,
      },
    },
  },

  // ── 异步图像模型 (POST /v1/images/tasks) ──
  {
    model: "wand-vega-image-pro",
    displayName: "WAND-Vega Image Pro",
    family: "WAND-Vega Image",
    capability: "image",
    protocol: "ysdui-image-task",
    endpoint: "POST /v1/images/tasks",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 14,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: WAND_VEGA_IMAGE_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["1k", "2k", "4k"],
          default: "1k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 1,
      },
    },
  },
  {
    model: "wand-vega-image-1.5-pro",
    displayName: "WAND-Vega Image 1.5 Pro",
    family: "WAND-Vega Image",
    capability: "image",
    protocol: "ysdui-image-task",
    endpoint: "POST /v1/images/tasks",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 14,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: WAND_VEGA_IMAGE_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["1k", "2k", "4k"],
          default: "1k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 1,
      },
    },
  },
  {
    model: "wand-vega-image-flash",
    displayName: "WAND-Vega Image Flash",
    family: "WAND-Vega Image",
    capability: "image",
    protocol: "ysdui-image-task",
    endpoint: "POST /v1/images/tasks",
    capabilityConfig: {
      version: 1,
      image: {
        references: {
          promptMaxChars: 4000,
          maxImages: 14,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: WAND_VEGA_IMAGE_SIZES,
          default: "1:1",
          allowCustom: true,
        },
        quality: {
          supported: true,
          values: ["1k", "2k", "4k"],
          default: "1k",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 1,
      },
    },
  },

  // ── 统一异步视频模型 (POST /v1/video/generations) ──
  {
    model: "doubao-seedance-2-0-260128",
    displayName: "Doubao Seedance 2.0",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-0-fast-260128",
    displayName: "Doubao Seedance 2.0 Fast",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-0-mini-260615",
    displayName: "Doubao Seedance 2.0 Mini",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-5-260628",
    displayName: "Doubao Seedance 2.5",
    family: "Seedance 2.5",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "wan3.0-video",
    displayName: "Wan 3.0 Video",
    family: "Wan 3.0",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 5,
          maxVideos: 3,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 2, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "wan3.0-video-prime",
    displayName: "Wan 3.0 Video Prime",
    family: "Wan 3.0",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 5,
          maxVideos: 3,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 2, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
        defaultRatio: "16:9",
        resolutions: ["720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "minimax-h3",
    displayName: "MiniMax H3",
    family: "MiniMax H3",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxVideoBytes: 50 * 1024 * 1024,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["768P"],
        defaultResolution: "768P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "wand-vega-video-1.0-lite",
    displayName: "WAND-Vega Video 1.0 Lite",
    family: "WAND-Vega Video",
    capability: "video",
    protocol: "ysdui-video",
    endpoint: "POST /v1/video/generations",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 7,
          maxVideos: 1,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
        defaultRatio: "16:9",
        resolutions: ["720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
];

function getReact(host) {
  if (host?.React) return host.React;
  if (host?.ui?.React) return host.ui.React;
  if (typeof window !== "undefined") {
    return window.__BEEFTV_REACT__ || window.React || null;
  }
  return null;
}

export function upgradeYsduiModelProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  if (!String(profile.protocol || "").startsWith("ysdui-")) return profile;
  const preset = YSDUI_PRESET_MODELS.find((item) => item.model === profile.model);
  if (!preset) return profile;
  let next = profile;
  const presetRes = preset.capabilityConfig?.video?.resolutions;
  const currentRes = next.capabilityConfig?.video?.resolutions;
  if (Array.isArray(presetRes) && Array.isArray(currentRes)) {
    const validSet = new Set(presetRes);
    if (currentRes.some((r) => !validSet.has(r))) {
      const filtered = currentRes.filter((r) => validSet.has(r));
      const resolutions = filtered.length > 0 ? filtered : [...presetRes];
      const defaultResolution = validSet.has(next.capabilityConfig.video.defaultResolution)
        ? next.capabilityConfig.video.defaultResolution
        : preset.capabilityConfig.video.defaultResolution;
      next = {
        ...next,
        capabilityConfig: {
          ...next.capabilityConfig,
          video: {
            ...next.capabilityConfig.video,
            resolutions,
            defaultResolution,
          },
        },
      };
    }
  }
  return next;
}

export function buildYsduiModelChannel({ apiKey, baseUrl, selectedModels, existingChannel }) {
  const cleanUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const cleanKey = String(apiKey || "").trim();
  const presetModelIds = new Set(YSDUI_PRESET_MODELS.map((item) => item.model));
  const chosenSet = new Set(
    Array.isArray(selectedModels) && selectedModels.length
      ? selectedModels
      : YSDUI_PRESET_MODELS.map((item) => item.model),
  );
  const activePresets = YSDUI_PRESET_MODELS.filter((item) => chosenSet.has(item.model));
  const customModels = Array.isArray(existingChannel?.models)
    ? existingChannel.models.filter((id) => !presetModelIds.has(id) && chosenSet.has(id))
    : [];
  const customProfiles = Array.isArray(existingChannel?.modelProfiles)
    ? existingChannel.modelProfiles.filter((profile) => !presetModelIds.has(profile.model) && chosenSet.has(profile.model))
    : [];
  const models = [...activePresets.map((item) => item.model), ...customModels];
  const modelProfiles = [
    ...activePresets.map((item) => ({
      model: item.model,
      displayName: item.displayName,
      capability: item.capability,
      protocol: item.protocol,
      authType: "bearer",
      ...(item.defaultOptions ? { defaultOptions: item.defaultOptions } : {}),
      capabilityConfig: item.capabilityConfig,
    })),
    ...customProfiles,
  ];

  return {
    id: YSDUI_CHANNEL_ID,
    name: existingChannel?.name || YSDUI_CHANNEL_NAME,
    scope: "user",
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    hasApiKey: Boolean(cleanKey || existingChannel?.hasApiKey),
    apiFormat: "openai",
    models,
    modelProfiles,
  };
}

function capabilityBadgeStyle(capability) {
  if (capability === "text") {
    return {
      background: "rgba(59, 130, 246, 0.12)",
      color: "#2563eb",
      label: "文本",
    };
  }
  if (capability === "image") {
    return {
      background: "rgba(16, 185, 129, 0.12)",
      color: "#059669",
      label: "图片",
    };
  }
  return {
    background: "rgba(139, 92, 246, 0.12)",
    color: "#7c3aed",
    label: "视频",
  };
}

function createYsduiSettingsPanel(host) {
  const React = getReact(host);
  if (!React) return () => null;
  const h = React.createElement;

  return function YsduiSettingsPanel(props) {
    const existingChannel = React.useMemo(() => {
      try {
        const channels = host?.channels?.list?.() || [];
        return channels.find(
          (item) =>
            item.id === YSDUI_CHANNEL_ID ||
            String(item.baseUrl || "").includes("ysdui.cn"),
        );
      } catch {
        return undefined;
      }
    }, []);

    const initialApiKey =
      props?.config?.apiKey ||
      host?.config?.get?.("apiKey", "") ||
      existingChannel?.apiKey ||
      "";
    const initialBaseUrl =
      props?.config?.baseUrl ||
      host?.config?.get?.("baseUrl", DEFAULT_BASE_URL) ||
      existingChannel?.baseUrl ||
      DEFAULT_BASE_URL;

    const [apiKey, setApiKey] = React.useState(String(initialApiKey));
    const [baseUrl, setBaseUrl] = React.useState(String(initialBaseUrl));
    const [showKey, setShowKey] = React.useState(false);
    const [selectedModels, setSelectedModels] = React.useState(() =>
      existingChannel?.models?.length
        ? existingChannel.models
        : YSDUI_PRESET_MODELS.map((item) => item.model),
    );
    const [catalogChecking, setCatalogChecking] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [onlineModels, setOnlineModels] = React.useState([]);
    const [synced, setSynced] = React.useState(
      Boolean(existingChannel?.hasApiKey || existingChannel?.apiKey),
    );
    const [statusMessage, setStatusMessage] = React.useState(
      existingChannel?.hasApiKey || existingChannel?.apiKey
        ? `已连接「${existingChannel.name}」渠道（已启用 ${existingChannel.models?.length || 0} 个模型）`
        : "",
    );
    const [errorMessage, setErrorMessage] = React.useState("");

    const toggleModel = (modelId) => {
      setSelectedModels((prev) =>
        prev.includes(modelId)
          ? prev.filter((item) => item !== modelId)
          : [...prev, modelId],
      );
    };

    const handleFetchCatalog = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
      if (!trimmedKey) {
        setErrorMessage("请先填写银盛云枢壹算 API Key");
        return;
      }
      setCatalogChecking(true);
      setErrorMessage("");
      try {
        let ids = [];
        if (typeof host?.channels?.fetchCatalog === "function") {
          const catalog = await host.channels.fetchCatalog({
            baseUrl: trimmedUrl,
            apiKey: trimmedKey,
            apiFormat: "openai",
          });
          ids = Array.isArray(catalog?.models) ? catalog.models : [];
        } else {
          const resp = await fetch("/api/ai/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseUrl: trimmedUrl,
              apiKey: trimmedKey,
              apiFormat: "openai",
            }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || (typeof data?.code === "number" && data.code !== 0)) {
            throw new Error(
              data?.msg || data?.error || `读取在线目录失败（HTTP ${resp.status}）`,
            );
          }
          const rawModels = Array.isArray(data?.data?.models)
            ? data.data.models
            : Array.isArray(data?.models)
              ? data.models
              : [];
          ids = rawModels
            .map((item) => (typeof item === "string" ? item : item?.id))
            .filter(Boolean);
        }
        setOnlineModels(ids);
        setStatusMessage(`在线目录验证成功：共发现 ${ids.length} 个上游模型`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "读取在线目录失败");
      } finally {
        setCatalogChecking(false);
      }
    };

    const handleSaveAndSync = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
      const hasSavedKey = Boolean(existingChannel?.hasApiKey || existingChannel?.apiKey);
      if (!trimmedKey && !hasSavedKey) {
        setErrorMessage("请填写有效的银盛云枢壹算 API Key（sk-...）");
        return;
      }
      if (!selectedModels.length) {
        setErrorMessage("请至少勾选 1 个要同步的模型");
        return;
      }
      setSaving(true);
      setErrorMessage("");
      try {
        const patch = trimmedKey ? { apiKey: trimmedKey, baseUrl: trimmedUrl } : { baseUrl: trimmedUrl };
        if (typeof props?.updateConfig === "function") {
          await props.updateConfig(patch);
        } else if (host?.config?.set) {
          await host.config.set(patch);
        }
        const channel = buildYsduiModelChannel({
          apiKey: trimmedKey,
          baseUrl: trimmedUrl,
          selectedModels,
          existingChannel,
        });
        if (!host?.channels?.upsert) {
          throw new Error("当前宿主版本不支持同步模型渠道");
        }
        await host.channels.upsert(channel);
        setSynced(true);
        setStatusMessage(
          `已将「${YSDUI_CHANNEL_NAME}」与 ${channel.models.length} 个模型同步至「设置 -> 模型服务」！`,
        );
        host?.ui?.notify?.("银盛云枢壹算渠道与模型已同步至模型服务", "success");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "保存并同步渠道失败");
      } finally {
        setSaving(false);
      }
    };

    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "4px 0",
        },
      },
      // 顶部品牌介绍卡片
      h(
        "div",
        {
          style: {
            borderRadius: "12px",
            border: "1px solid rgba(59, 130, 246, 0.22)",
            background:
              "linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, rgba(16, 185, 129, 0.05) 100%)",
            padding: "14px 16px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "6px",
            },
          },
          h(
            "div",
            { style: { fontWeight: 600, fontSize: "14px" } },
            "银盛云枢壹算 (OneAxis) · BYOK 一键接入",
          ),
          h(
            "span",
            {
              style: {
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: "rgba(16, 185, 129, 0.14)",
                color: "#059669",
                fontWeight: 600,
              },
            },
            "官方内置插件",
          ),
        ),
        h(
          "p",
          {
            style: {
              margin: 0,
              fontSize: "12px",
              opacity: 0.75,
              lineHeight: 1.6,
            },
          },
          `只需填写一个银盛云枢壹算 API Key，即可一键配置 DeepSeek、Qwen、GLM、Kimi、豆包 Seedream 5.0 / Seedance 2.0 & 2.5、Wan 3.0、MiniMax H3、混元 Image 3.0 与 WAND-Vega 共 ${YSDUI_PRESET_MODELS.length} 款文本、图像与视频模型协议。`,
        ),
      ),

      // 表单区
      h(
        "div",
        {
          style: {
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "12px",
          },
        },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "ysdui-plugin-base-url",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "接口地址 (Base URL)",
          ),
          h("input", {
            id: "ysdui-plugin-base-url",
            type: "text",
            value: baseUrl,
            onChange: (e) => setBaseUrl(e.target.value),
            placeholder: DEFAULT_BASE_URL,
            style: {
              width: "100%",
              padding: "8px 12px",
              borderRadius: "8px",
              border: "1px solid rgba(128,128,128,0.28)",
              background: "transparent",
              fontSize: "13px",
              fontFamily: "monospace",
            },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "ysdui-plugin-api-key",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "银盛云枢壹算 API Key",
          ),
          h(
            "div",
            { style: { display: "flex", gap: "8px" } },
            h("input", {
              id: "ysdui-plugin-api-key",
              "aria-label": "银盛云枢壹算 API Key",
              type: showKey ? "text" : "password",
              value: apiKey,
              onChange: (e) => setApiKey(e.target.value),
              placeholder: "sk-...",
              style: {
                flex: 1,
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(128,128,128,0.28)",
                background: "transparent",
                fontSize: "13px",
                fontFamily: "monospace",
              },
            }),
            h(
              "button",
              {
                type: "button",
                onClick: () => setShowKey((v) => !v),
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(128,128,128,0.28)",
                  background: "transparent",
                  fontSize: "12px",
                  cursor: "pointer",
                },
              },
              showKey ? "隐藏" : "显示",
            ),
            h(
              "button",
              {
                type: "button",
                disabled: catalogChecking,
                onClick: handleFetchCatalog,
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(59, 130, 246, 0.35)",
                  background: "rgba(59, 130, 246, 0.08)",
                  color: "#2563eb",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: catalogChecking ? "wait" : "pointer",
                },
              },
              catalogChecking ? "验证中..." : "验证在线目录",
            ),
          ),
        ),
      ),

      // 预置模型与协议映射清单
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            },
          },
          h(
            "span",
            { style: { fontSize: "12px", fontWeight: 600 } },
            `预置协议模型（已选 ${selectedModels.length} / ${YSDUI_PRESET_MODELS.length}）`,
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () =>
                setSelectedModels(
                  selectedModels.length === YSDUI_PRESET_MODELS.length
                    ? []
                    : YSDUI_PRESET_MODELS.map((item) => item.model),
                ),
              style: {
                border: "none",
                background: "transparent",
                color: "#2563eb",
                fontSize: "12px",
                cursor: "pointer",
              },
            },
            selectedModels.length === YSDUI_PRESET_MODELS.length ? "取消全选" : "全选模型",
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "8px",
            },
          },
          YSDUI_PRESET_MODELS.map((item) => {
            const checked = selectedModels.includes(item.model);
            const isOnline =
              onlineModels.includes(item.model) ||
              onlineModels.some((m) =>
                String(m).toLowerCase().endsWith(item.model.toLowerCase()),
              );
            const badge = capabilityBadgeStyle(item.capability);
            return h(
              "label",
              {
                key: item.model,
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: checked
                    ? "1px solid rgba(59, 130, 246, 0.45)"
                    : "1px solid rgba(128, 128, 128, 0.2)",
                  background: checked ? "rgba(59, 130, 246, 0.05)" : "transparent",
                  cursor: "pointer",
                  fontSize: "12px",
                },
              },
              h("input", {
                type: "checkbox",
                checked,
                onChange: () => toggleModel(item.model),
                style: { marginTop: "3px" },
              }),
              h(
                "div",
                { style: { flex: 1, minWidth: 0 } },
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "4px",
                      fontWeight: 600,
                    },
                  },
                  h("span", null, item.displayName),
                  h(
                    "span",
                    {
                      style: {
                        fontSize: "10px",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background: badge.background,
                        color: badge.color,
                      },
                    },
                    badge.label,
                  ),
                ),
                h(
                  "div",
                  {
                    style: {
                      fontSize: "11px",
                      opacity: 0.65,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  `${item.model} · ${item.endpoint}`,
                ),
                isOnline
                  ? h(
                      "div",
                      { style: { fontSize: "10px", color: "#059669", marginTop: "2px" } },
                      "● 上游目录已确认在线",
                    )
                  : null,
              ),
            );
          }),
        ),
      ),

      // 状态反馈区
      errorMessage
        ? h(
            "div",
            {
              role: "alert",
              style: {
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "#dc2626",
                fontSize: "12px",
              },
            },
            errorMessage,
          )
        : null,
      statusMessage
        ? h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                color: "#059669",
                fontSize: "12px",
              },
            },
            h("span", null, statusMessage),
            synced
              ? h(
                  "button",
                  {
                    type: "button",
                    onClick: () => host?.ui?.navigate?.("/settings?section=channels"),
                    style: {
                      padding: "4px 10px",
                      borderRadius: "6px",
                      border: "1px solid rgba(16, 185, 129, 0.4)",
                      background: "rgba(16, 185, 129, 0.12)",
                      color: "#047857",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    },
                  },
                  "前往模型服务查看与测试 →",
                )
              : null,
          )
        : null,

      // 底部操作按钮
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            paddingTop: "4px",
          },
        },
        h(
          "button",
          {
            type: "button",
            disabled: saving,
            onClick: handleSaveAndSync,
            style: {
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: saving ? "wait" : "pointer",
            },
          },
          saving ? "同步中..." : "一键保存并同步到模型服务",
        ),
      ),
    );
  };
}

export function activate(host) {
  const SettingsPanel = createYsduiSettingsPanel(host);
  const dispose = host.contribute("app.settings", {
    id: "ysdui-settings",
    label: "银盛云枢壹算算力与多模态渠道",
    component: SettingsPanel,
  });
  return () => {
    if (typeof dispose === "function") dispose();
  };
}

export default { activate };
