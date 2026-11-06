import { Modal, type ModalProps } from "antd";
import type { CSSProperties } from "react";

// 用途：产品弹窗壳。消费 token 由内容自己负责。接管 AntD Modal 的重复 flush 内边距。
const FLUSH_STYLES = {
    container: { padding: 0, overflow: "hidden" },
    body: { padding: 0 },
} as const;

export type AppModalProps = ModalProps & {
    /** 内容自带外壳时去掉 AntD 默认内边距，避免每个业务弹窗复制同一套 styles。 */
    flush?: boolean;
    /** 普通详情/表单由壳负责滚动；自带布局的浮层保持原行为。 */
    scrollBody?: boolean;
};

export function AppModal({ flush = false, scrollBody = false, destroyOnHidden = true, centered = true, styles, className, ...props }: AppModalProps) {
    const mergeResolvedStyles = (resolved: unknown) => {
        const base = resolved && typeof resolved === "object" ? (resolved as Record<string, unknown>) : {};
        const suppliedBody = base.body && typeof base.body === "object" ? (base.body as CSSProperties) : {};
        const scrollStyles = scrollBody ? { maxHeight: "70dvh", overflowY: "auto" as const, overscrollBehavior: "contain" as const } : {};
        if (!flush) return { ...base, body: { ...scrollStyles, ...suppliedBody } };
        const container = base.container && typeof base.container === "object" ? (base.container as CSSProperties) : {};
        const body = base.body && typeof base.body === "object" ? (base.body as CSSProperties) : {};
        return {
            ...base,
            container: { ...container, ...FLUSH_STYLES.container },
            body: { ...scrollStyles, ...body, ...FLUSH_STYLES.body },
        };
    };
    const mergedStyles =
        typeof styles === "function"
            ? (info: { props: ModalProps }) => mergeResolvedStyles(styles(info))
            : mergeResolvedStyles(styles);

    return <Modal destroyOnHidden={destroyOnHidden} centered={centered} {...props} className={[className, scrollBody && "workspace-dialog"].filter(Boolean).join(" ")} styles={mergedStyles as ModalProps["styles"]} />;
}
