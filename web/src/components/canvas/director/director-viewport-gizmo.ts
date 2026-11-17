import { useEffect, useMemo, useRef } from "react";
import { Camera, Object3D, OrthographicCamera, PerspectiveCamera } from "three";

import { createDirectorTransaction, installDirectorTerminalListeners } from "@/lib/canvas/director/director-gesture-transaction";
import type { DirectorTransform, DirectorVec3 } from "@/types/director";

/**
 * gizmo 事务的统一接线：对象与骨骼共用，避免两套实现产生偏差。
 * 监听在挂载期间常驻安装（不以「当前是否有手势」为安装条件），
 * 非活跃时 end 自身是空操作。
 */
export function useDirectorGizmoTransaction<TSnapshot>({
    read,
    restore,
    commit,
    onActive,
}: {
    read: () => TSnapshot | null;
    restore: (snapshot: TSnapshot) => void;
    commit: (from: TSnapshot, to: TSnapshot) => void;
    onActive: (active: boolean, snapshot: TSnapshot | null) => void;
}) {
    const hooksRef = useRef({ read, restore, commit, onActive });
    useEffect(() => {
        hooksRef.current = { read, restore, commit, onActive };
    }, [commit, onActive, read, restore]);

    const transaction = useMemo(() => createDirectorTransaction<TSnapshot>({
        read: () => hooksRef.current.read(),
        restore: (snapshot) => hooksRef.current.restore(snapshot),
        commit: (from, to) => hooksRef.current.commit(from, to),
        setActive: (active) => hooksRef.current.onActive(active, active ? hooksRef.current.read() : null),
        // stdlib 在 domElement.ownerDocument 上注册 pointerup，其 pointerUp({button:0})
        // 会 dispatch mouseUp 后清 dragging=false / axis=null。因此用真实事件走它自己的
        // 收尾通道，而不是写它的私有字段（.d.ts 中 dragging/axis 均为 private）。
        terminateDrag: () => document.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true })),
    }), []);

    useEffect(() => installDirectorTerminalListeners(transaction, {
        window,
        document,
        isHidden: () => document.visibilityState === "hidden",
    }), [transaction]);

    // 取消选中、删除对象、切换模型或卸载都必须回到快照并释放 transforming。
    useEffect(() => () => transaction.end("cancel"), [transaction]);

    return transaction;
}

export function readObject3DTransform(target: Object3D): DirectorTransform {
    return {
        position: target.position.toArray() as DirectorVec3,
        rotation: [target.rotation.x, target.rotation.y, target.rotation.z],
        scale: target.scale.toArray() as DirectorVec3,
    };
}

export function applyObject3DTransform(target: Object3D, transform: DirectorTransform) {
    target.position.set(...transform.position);
    target.rotation.set(...transform.rotation);
    target.scale.set(...transform.scale);
    target.updateMatrixWorld(true);
}

export function screenPixelsToWorldRadius(camera: Camera, distance: number, pixels: number, viewportHeight: number) {
    const height = Math.max(1, viewportHeight);
    if (camera instanceof PerspectiveCamera) return (pixels * 2 * Math.max(0.01, distance) * Math.tan((camera.fov * Math.PI) / 360)) / (height * Math.max(0.01, camera.zoom));
    if (camera instanceof OrthographicCamera) return (pixels * (camera.top - camera.bottom)) / (height * Math.max(0.01, camera.zoom));
    return pixels * 0.001;
}
