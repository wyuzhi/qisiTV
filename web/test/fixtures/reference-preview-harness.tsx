import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Texture, TextureLoader } from "three";
import { GLTFLoader } from "three-stdlib";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasFolderPreview } from "@/components/canvas/canvas-folder-preview";
import { DirectorBillboard, DirectorModel } from "@/components/canvas/director/director-viewport";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { resetReferencePreviewCacheForTests, useResolvedCanvasResourceReferences } from "@/components/canvas/use-resolved-canvas-resource-references";
import { acquireCanvasVideoPreview } from "@/services/canvas-video-preview";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasResourceMentionTextarea } from "@/components/canvas/canvas-resource-mention-textarea";
import { CanvasNodeType } from "@/types/canvas";
import type { DirectorObject } from "@/types/director";

const harness = window as any;
harness.captures = [];
harness.pending = new Map();
harness.revoked = [];
harness.textureLoads = [];
harness.gltfLoads = [];
harness.modelLoadStates = [];
TextureLoader.prototype.load = function (url: string, onLoad?: (data: Texture) => void) {
    harness.textureLoads.push(url);
    const tex = new Texture();
    queueMicrotask(() => onLoad?.(tex));
    return tex;
} as typeof TextureLoader.prototype.load;
GLTFLoader.prototype.load = function (url: string) {
    harness.gltfLoads.push(url);
} as typeof GLTFLoader.prototype.load;
const revoke = URL.revokeObjectURL.bind(URL);
URL.revokeObjectURL = (url) => { harness.revoked.push(url); revoke(url); };
const held: ReturnType<typeof acquireCanvasVideoPreview>[] = [];
harness.holdVideo = async (id: string) => {
    const lease = acquireCanvasVideoPreview({ metadata: { content: id } });
    held.push(lease);
    await lease.promise;
};
harness.releaseHeld = () => held.splice(0).forEach(lease => lease.release());
harness.probePool = async () => {
    const lease = acquireCanvasVideoPreview({ metadata: { content: "probe" } });
    const result = await lease.promise;
    lease.release();
    return Boolean(result?.content);
};

function Harness() {
    const [references, setReferences] = useState<CanvasResourceReference[]>([]);
    const [showMenu, setShowMenu] = useState(false);
    const [passResolvedToMenu, setPassResolvedToMenu] = useState(false);
    const [latchedMenuReferences, setLatchedMenuReferences] = useState<CanvasResourceReference[] | null>(null);
    const [value, setValue] = useState("");
    const [composerInputs, setComposerInputs] = useState<NodeGenerationInput[] | null>(null);
    const [localCachedImage, setLocalCachedImage] = useState<{ storageKey?: string; src?: string } | null>(null);
    const [billboardObject, setBillboardObject] = useState<DirectorObject | null>(null);
    const [modelObject, setModelObject] = useState<DirectorObject | null>(null);
    const [folderCoverUrl, setFolderCoverUrl] = useState<string | null>(null);
    const resolved = useResolvedCanvasResourceReferences(references);
    harness.setReferences = setReferences;
    harness.setValue = setValue;
    harness.getValue = () => value;
    harness.resetPreviewCache = resetReferencePreviewCacheForTests;
    harness.showMenu = (useResolved = false) => { setLatchedMenuReferences(null); setPassResolvedToMenu(useResolved); setShowMenu(true); };
    harness.latchMenuReferences = () => setLatchedMenuReferences(resolved);
    harness.mountComposer = (inputs: NodeGenerationInput[], initialValue: string) => { setValue(initialValue); setComposerInputs(inputs); };
    harness.mountLocalCachedImage = (props: { storageKey?: string; src?: string } | null) => setLocalCachedImage(props);
    harness.mountBillboard = (object: DirectorObject | null) => setBillboardObject(object);
    harness.mountModel = (object: DirectorObject | null) => setModelObject(object);
    harness.mountFolderPreview = (coverUrl: string | null) => setFolderCoverUrl(coverUrl);
    return <><pre id="result">{JSON.stringify(resolved.map(({ id, previewUrl }) => ({ id, previewUrl })))}</pre>
        <pre id="composer-value">{value}</pre>
        <div id="resolved-previews">{resolved.map(reference => reference.previewUrl && <img key={reference.id} data-reference-id={reference.id} src={reference.previewUrl} />)}</div>
        {showMenu && <CanvasResourceMentionTextarea value={value} onChange={setValue} references={latchedMenuReferences ?? (passResolvedToMenu ? resolved : references)} onSelectReference={(reference) => reference} aria-label="引用编辑" />}
        {composerInputs && <CanvasConfigComposer value={value} inputs={composerInputs} onChange={setValue} onClose={() => setComposerInputs(null)} />}
        {localCachedImage && (
            <div id="local-cached-image">
                <CachedResourceImage
                    storageKey={localCachedImage.storageKey}
                    src={localCachedImage.src}
                    loadingFallback={<span data-loading="true">加载中</span>}
                    fallback={<span data-error-fallback="true">加载失败占位</span>}
                />
            </div>
        )}
        {billboardObject && <DirectorBillboard object={billboardObject} selected={false} />}
        {modelObject && (
            <DirectorModel
                object={modelObject}
                selected={false}
                selectedBone={null}
                showBoneControls={false}
                playhead={0}
                onSelectBone={() => {}}
                onBoneTransform={() => {}}
                onActorRigReady={() => {}}
                onLoadStateChange={(id, signal) => harness.modelLoadStates.push({ id, signal })}
            />
        )}
        {folderCoverUrl && (
            <div style={{ width: 360, height: 280 }}>
                <CanvasFolderPreview
                    data={{
                        id: "folder-1",
                        type: CanvasNodeType.Folder,
                        title: "测试文件夹",
                        position: { x: 0, y: 0 },
                        width: 360,
                        height: 280,
                        metadata: { folder: { collapsed: true, style: "glass", theme: "aurora", themeCover: folderCoverUrl } },
                    }}
                    childNodes={[]}
                    active={false}
                    isDropTarget={false}
                    readOnly={false}
                    onToggleCollapsed={() => {}}
                    onTitleChange={() => {}}
                    onStyleChange={() => {}}
                    onThemeChange={() => {}}
                />
            </div>
        )}</>;
}

createRoot(document.getElementById("root")!).render(<Harness />);
