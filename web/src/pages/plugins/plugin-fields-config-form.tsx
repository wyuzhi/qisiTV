import { Button, Input, InputNumber, Select } from "antd";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { Switch } from "@/components/ui/base/switch";
import type { PluginField } from "@/lib/plugins/plugin-types";

/** 插件在清单 configuration.fields 里声明的设置表单。 */
export function PluginFieldsConfigForm({
    fields,
    initialValues,
    onSave,
}: {
    fields: PluginField[];
    initialValues: Record<string, unknown>;
    onSave: (values: Record<string, unknown>) => void;
}) {
    const [values, setValues] = useState<Record<string, unknown>>(() => {
        const defaults: Record<string, unknown> = {};
        for (const field of fields) {
            defaults[field.name] = initialValues[field.name] !== undefined ? initialValues[field.name] : field.default;
        }
        return defaults;
    });

    return (
        <>
            <div className="plugin-settings-fields">
                {fields.map((field) => {
                    const currentValue = values[field.name];
                    const labelText = field.label || field.name;
                    return (
                        <div key={field.name} className="min-w-0">
                            {field.type === "boolean" ? (
                                <div className="plugin-setting-label-row">
                                    <label htmlFor={`plugin-field-${field.name}`}>{labelText}</label>
                                    <Switch
                                        id={`plugin-field-${field.name}`}
                                        checked={Boolean(currentValue)}
                                        onChange={(checked) => setValues((prev) => ({ ...prev, [field.name]: checked }))}
                                        aria-label={labelText}
                                    />
                                </div>
                            ) : (
                                <>
                                    <label htmlFor={`plugin-field-${field.name}`}>{labelText}</label>
                                    {field.type === "select" ? (
                                        <Select
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : undefined}
                                            options={(field.values || []).map((val) => ({ value: val, label: val }))}
                                            onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
                                        />
                                    ) : field.type === "number" ? (
                                        <InputNumber
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            className="w-full"
                                            value={typeof currentValue === "number" ? currentValue : undefined}
                                            onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
                                        />
                                    ) : field.type === "secret" ? (
                                        <Input.Password
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : ""}
                                            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                                        />
                                    ) : (
                                        <Input
                                            id={`plugin-field-${field.name}`}
                                            aria-label={labelText}
                                            value={typeof currentValue === "string" ? currentValue : ""}
                                            onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                                        />
                                    )}
                                </>
                            )}
                            {field.description ? <p>{field.description}</p> : null}
                        </div>
                    );
                })}
            </div>
            <div className="plugin-settings-actions">
                <Button type="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => onSave(values)}>
                    保存配置
                </Button>
            </div>
        </>
    );
}
