import { Form, type FormProps } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { workspaceControlMetrics as metrics } from "@/lib/workspace-control-metrics";
import "@/styles/workspace-controls.css";

const controlVariables = {
    "--workspace-field-gap": `${metrics.fieldGap}px`,
    "--workspace-label-gap": `${metrics.labelGap}px`,
    "--workspace-control-font": `${metrics.fontSize.normal}px`,
    "--workspace-control-line": `${metrics.lineHeight.normal}px`,
    "--workspace-small-height": `${metrics.height.small}px`,
    "--workspace-small-radius": `${metrics.radius.small}px`,
    "--workspace-small-font": `${metrics.fontSize.small}px`,
} as CSSProperties;

/** Product form defaults; AntD still owns field binding, validation and refs. */
export function WorkspaceForm<Values extends object = Record<string, unknown>>({ className, style, ...props }: Omit<FormProps<Values>, "children"> & { children?: ReactNode }) {
    return <Form<Values>
        layout="vertical"
        requiredMark={false}
        scrollToFirstError={{ focus: true, block: "center" }}
        {...props}
        className={cn("workspace-form workspace-controls-form", className)}
        style={{ ...controlVariables, ...style }}
    />;
}
