import { AudioLines, Clapperboard, Image, Layers3, Scissors, Video } from "lucide-react";

export const qisitvCapabilityItems = [
    { id: "canvas", label: "自由画布", detail: "组织镜头与素材", to: "/canvas?mode=new", icon: Layers3, disabled: false },
    { id: "video", label: "视频生成", detail: "在画布中创建视频节点", to: "/canvas?mode=new&add=video", icon: Video, disabled: false },
    { id: "image", label: "图片生成", detail: "在画布中创建图片节点", to: "/canvas?mode=new&add=image", icon: Image, disabled: false },
    // Audio generation is a creation entry, not an asset filter. Start a
    // local canvas and let the canvas insert the correctly configured node.
    { id: "audio", label: "音频生成", detail: "配音与声音素材", to: "/canvas?mode=new&add=audio", icon: AudioLines, disabled: false },
    { id: "edit", label: "智能剪辑", detail: "即将开放", to: "/canvas?mode=recent", icon: Scissors, disabled: true },
    { id: "projects", label: "项目制作", detail: "即将开放", to: "/project", icon: Clapperboard, disabled: true },
] as const;
