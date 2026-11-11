// 银盛云枢壹算 (OneAxis) 渠道常量、官方预置模型目录与旧配置升级规则（对照 https://www.ysdui.cn/docs）

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
  minImageAspect: 0,
  maxImageAspect: 0,
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
  minVideoAspect: 0,
  maxVideoAspect: 0,
  minVideoPixels: 0,
  maxVideoPixels: 0,
  maxAudios: 3,
  maxAudioBytes: 15 * 1024 * 1024,
  minAudioDurationSeconds: 0,
  maxAudioDurationSeconds: 15,
  maxAudioTotalDurationSeconds: 0,
};

function createTextCapability({ thinking = false, maxImages = 0, maxVideos = 0 } = {}) {
  return {
    version: 1,
    text: {
      references: {
        promptMaxChars: 32000,
        maxImages,
        maxImageBytes: maxImages > 0 ? 10 * 1024 * 1024 : 0,
        maxVideos,
        maxVideoBytes: maxVideos > 0 ? 20 * 1024 * 1024 : 0,
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

const HUNYUAN_IMAGE_SIZES = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "21:9",
  "1024x1024",
  "1280x720",
  "720x1280",
  "1024x768",
  "768x1024",
  "1152x768",
  "768x1152",
  "1344x576",
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

const SEEDANCE_DURATION_VALUES = [-1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const WAN_VIDEO_DURATION_VALUES = [-1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

export const YSDUI_PRESET_MODELS = [
  // ── 文本与多模态理解模型 (POST /v1/chat/completions) ──
  {
    model: "deepseek-v4.1-flash-1017",
    displayName: "DeepSeek V4.1 Flash (1017)",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "deepseek-v4-pro-0813",
    displayName: "DeepSeek V4 Pro",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "qwen3.8-max",
    displayName: "Qwen 3.8 Max",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "qwen3.8-flash",
    displayName: "Qwen 3.8 Flash",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "qwen3.7-max",
    displayName: "Qwen 3.7 Max",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "qwen3.7-plus",
    displayName: "Qwen 3.7 Plus",
    family: "Qwen 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "glm-5.3",
    displayName: "GLM-5.3",
    family: "GLM 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "glm-5.3-flash",
    displayName: "GLM-5.3 Flash",
    family: "GLM 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "kimi-k3",
    displayName: "Kimi K3",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10, maxVideos: 4 }),
  },
  {
    model: "kimi-k2.6",
    displayName: "Kimi K2.6",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "kimi-k2.7-code",
    displayName: "Kimi K2.7 Code",
    family: "Kimi 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10, maxVideos: 4 }),
  },
  {
    model: "minimax-m3",
    displayName: "MiniMax M3",
    family: "MiniMax 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true, maxImages: 10 }),
  },
  {
    model: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    family: "MiniMax 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "hy3",
    displayName: "混元 3.0",
    family: "混元 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "hy-role",
    displayName: "混元 Role",
    family: "混元 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: true }),
  },
  {
    model: "hy-mt2-pro",
    displayName: "混元 MT2 Pro",
    family: "混元 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: createTextCapability({ thinking: false }),
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
          values: ["2K", "3K", "4K", ...IMAGE_2K_SIZES],
          default: "2K",
          allowCustom: true,
        },
        quality: {
          supported: false,
          values: [],
          default: "auto",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: true, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: true },
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
          maxImages: 10,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: ["1K", "1.5K", "2K", ...IMAGE_1K_2K_SIZES],
          default: "2K",
          allowCustom: true,
        },
        quality: {
          supported: false,
          values: [],
          default: "auto",
        },
        transparentBackground: { supported: true, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: true },
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
          maxImages: 3,
          maxImageBytes: 10 * 1024 * 1024,
          maskSupported: false,
        },
        size: {
          parameter: "size",
          values: HUNYUAN_IMAGE_SIZES,
          default: "1:1",
          allowCustom: false,
        },
        quality: {
          supported: false,
          values: [],
          default: "auto",
        },
        transparentBackground: { supported: false, default: false },
        sequentialGeneration: { supported: false, default: false },
        responseFormat: { supported: true, value: "url" },
        outputFormat: { supported: false },
        maxOutputs: 1,
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
          maxVideoTotalDurationSeconds: 15,
          minAudioDurationSeconds: 2,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: SEEDANCE_DURATION_VALUES, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P", "4K"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
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
          maxVideoTotalDurationSeconds: 15,
          minAudioDurationSeconds: 2,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: SEEDANCE_DURATION_VALUES, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
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
          maxVideoTotalDurationSeconds: 15,
          minAudioDurationSeconds: 2,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: SEEDANCE_DURATION_VALUES, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
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
          maxVideoTotalDurationSeconds: 15,
          minAudioDurationSeconds: 2,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: SEEDANCE_DURATION_VALUES, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video", "inpaint", "extend"],
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
          maxImages: 10,
          maxVideos: 5,
          maxVideoTotalDurationSeconds: 15,
          maxAudios: 5,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: WAN_VIDEO_DURATION_VALUES, default: 5 },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
        defaultOperation: "text_to_video",
        operationReferences: {
          text_to_video: { maxImages: 0, maxVideos: 0, maxAudios: 0 },
          image_to_video: { minImages: 1, maxImages: 2, maxVideos: 0, maxAudios: 0 },
          reference_to_video: { maxImages: 10, maxVideos: 5, maxAudios: 5 },
        },
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
          maxImages: 10,
          maxVideos: 5,
          maxVideoTotalDurationSeconds: 15,
          maxAudios: 5,
          maxAudioTotalDurationSeconds: 15,
        },
        duration: { selection: "enum", values: WAN_VIDEO_DURATION_VALUES, default: 5 },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["480P", "720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video", "inpaint", "extend"],
        defaultOperation: "text_to_video",
        operationReferences: {
          text_to_video: { maxImages: 0, maxVideos: 0, maxAudios: 0 },
          image_to_video: { minImages: 1, maxImages: 2, maxVideos: 0, maxAudios: 0 },
          reference_to_video: { maxImages: 10, maxVideos: 5, maxAudios: 5 },
        },
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
          maxVideoBytes: 20 * 1024 * 1024,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["768P", "2K"],
        defaultResolution: "768P",
        generateAudio: { supported: false, default: true },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "audio_to_video", "reference_to_video"],
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
        resolutions: ["768P", "1080P"],
        defaultResolution: "768P",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
];

export function upgradeYsduiModelProfile(profile) {
  if (!profile || typeof profile !== "object") return profile;
  if (!String(profile.protocol || "").startsWith("ysdui-")) return profile;
  if (
    (typeof profile.imageCapabilitiesVersion === "string" && profile.imageCapabilitiesVersion.trim()) ||
    (typeof profile.videoCapabilitiesVersion === "string" && profile.videoCapabilitiesVersion.trim())
  ) {
    return profile;
  }
  const preset = YSDUI_PRESET_MODELS.find((item) => item.model === profile.model);
  if (!preset) return profile;

  if (profile.capabilitySource !== "user") {
    if (JSON.stringify(profile.capabilityConfig) === JSON.stringify(preset.capabilityConfig)) {
      return profile;
    }
    return {
      ...profile,
      capabilityConfig: structuredClone(preset.capabilityConfig),
    };
  }

  let next = profile;
  if (
    profile.model === "doubao-seedream-5-0-pro-260628" &&
    next.capabilityConfig?.image?.sequentialGeneration?.supported
  ) {
    next = {
      ...next,
      capabilityConfig: {
        ...next.capabilityConfig,
        image: {
          ...next.capabilityConfig.image,
          sequentialGeneration: { supported: false, default: false },
        },
      },
    };
  }
  const presetRes = preset.capabilityConfig?.video?.resolutions;
  const currentRes = next.capabilityConfig?.video?.resolutions;
  if (Array.isArray(presetRes) && Array.isArray(currentRes)) {
    const validSet = new Set(presetRes);
    if (currentRes.some((r) => !validSet.has(r))) {
      const filtered = currentRes.filter((r) => validSet.has(r));
      const resolutions = filtered.length > 0 ? filtered : [...presetRes];
      const currentDefault = next.capabilityConfig.video.defaultResolution;
      const presetDefault = preset.capabilityConfig.video.defaultResolution;
      const defaultResolution = resolutions.includes(currentDefault)
        ? currentDefault
        : resolutions.includes(presetDefault)
          ? presetDefault
          : resolutions[0];
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
      capabilityConfig: structuredClone(item.capabilityConfig),
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
