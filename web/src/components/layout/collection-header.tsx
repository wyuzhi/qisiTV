import { Dropdown, type MenuProps } from "antd";
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ExpandableSearch } from "./expandable-search";
import { PageHeader } from "./workspace-page";
import "@/styles/collection-header.css";

export type CollectionHeaderProps<Value extends string> = {
    title: string;
    className?: string;
    search?: { value: string; onChange: (value: string) => void; placeholder: string };
    actions?: ReactNode;
    createItems?: MenuProps["items"];
    primaryAction?: ReactNode;
    tabs: Array<{ value: Value; label: string; count?: number }>;
    value: Value;
    onChange: (value: Value) => void;
    navigationLabel: string;
    trailing?: ReactNode;
};

export function CollectionHeader<Value extends string>({ title, className, search, actions, createItems, primaryAction, tabs, value, onChange, navigationLabel, trailing }: CollectionHeaderProps<Value>) {
    return (
        <div className={cn("studio-band collection-header", className)}>
            <PageHeader title={title} actions={
                <div className="assets-header-actions">
                    <div className="assets-header-action-buttons">
                        <div className="assets-header-compact-actions">
                            {search ? <ExpandableSearch {...search} /> : null}
                            {actions}
                        </div>
                        {primaryAction ?? <Dropdown trigger={["click"]} menu={{ items: createItems }}>
                            <button type="button" className="collection-header-create"><Plus className="size-4" />新建</button>
                        </Dropdown>}
                    </div>
                </div>
            } />
            <div className="assets-kind-row">
                <nav className="assets-kind-tabs" aria-label={navigationLabel}>
                    {tabs.map((tab) => (
                        <button key={tab.value} type="button" className={cn("assets-kind-tab", value === tab.value && "is-active")}
                            aria-pressed={value === tab.value} onClick={() => onChange(tab.value)}>
                            {tab.label}
                            {tab.count !== undefined ? <span>{tab.count}</span> : null}
                        </button>
                    ))}
                </nav>
                {trailing ? <div className="assets-kind-actions">{trailing}</div> : null}
            </div>
        </div>
    );
}
