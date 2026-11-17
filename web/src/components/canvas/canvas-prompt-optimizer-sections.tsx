import { useEffect, useState } from "react";
import { Check, FileText, Image as ImageIcon, Music2, UserRound, Video } from "lucide-react";

import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { renderableMediaUrl } from "@/services/api/resources";

export function ResultList({ title, items, warning = false }: { title: string; items: string[]; warning?: boolean }) {
    return (
        <div className="canvas-prompt-optimizer-subsection">
            <div className="canvas-prompt-optimizer-field-label">
                <span>{title}</span>
            </div>
            <ul className={`canvas-prompt-optimizer-list ${warning ? "is-warning" : ""}`}>
                {items.map((item) => (
                    <li key={item} className="list-disc pl-1 marker:text-foreground/35">
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function ReferenceSelection({ references, selectedReferences, onToggle }: { references: CanvasResourceReference[]; selectedReferences: CanvasResourceReference[]; onToggle: (referenceId: string) => void }) {
    return (
        <div className="canvas-prompt-optimizer-reference-selection">
            <div className="canvas-prompt-optimizer-reference-heading">
                <span>参考内容</span>
                <span>{references.length ? `已选 ${selectedReferences.length}/${references.length}` : "当前上下文未连接参考"}</span>
            </div>
            {references.length ? (
                <div className="canvas-prompt-optimizer-reference-list" role="group" aria-label="本次优化使用的参考内容">
                    {references.map((reference) => {
                        const selected = selectedReferences.some((item) => item.id === reference.id);
                        return (
                            <button
                                key={reference.id}
                                type="button"
                                className={`canvas-prompt-optimizer-reference-chip ${selected ? "is-selected" : ""}`}
                                aria-pressed={selected}
                                onClick={() => onToggle(reference.id)}
                                title={`${selected ? "取消使用" : "使用"} ${reference.title || reference.label}`}
                            >
                                <ReferencePreview reference={reference} />
                                <span className="canvas-prompt-optimizer-reference-chip-label">{reference.title || reference.label}</span>
                                {selected ? <Check className="size-3.5" aria-hidden="true" /> : null}
                            </button>
                        );
                    })}
                </div>
            ) : (
                <p className="canvas-prompt-optimizer-reference-empty">请先添加参考图片、视频、音频、角色或文本，再使用此模式。</p>
            )}
        </div>
    );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
    const safeUrl = renderableMediaUrl(reference.previewUrl);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        setFailed(false);
    }, [safeUrl]);

    if ((reference.kind === "image" || reference.kind === "character") && safeUrl && !failed) {
        return <img className="canvas-prompt-optimizer-reference-chip-preview" src={safeUrl} alt="" onError={() => setFailed(true)} />;
    }
    const Icon = reference.kind === "text" ? FileText : reference.kind === "video" ? Video : reference.kind === "audio" ? Music2 : reference.kind === "character" ? UserRound : ImageIcon;
    return (
        <span className="canvas-prompt-optimizer-reference-chip-icon">
            <Icon className="size-3.5" aria-hidden="true" />
        </span>
    );
}
