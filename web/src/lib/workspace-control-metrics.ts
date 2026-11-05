// Existing workspace geometry. Page-specific asset/home exceptions stay local.
export const workspaceControlMetrics = {
    height: { small: 30, normal: 38, large: 44 },
    radius: { small: 8, normal: 12, large: 14 },
    buttonPadding: { small: 10, normal: 14 },
    inputPadding: 12,
    iconSize: 16,
    gap: 8,
    fieldGap: 20,
    labelGap: 8,
    fontSize: { small: 12, normal: 13 },
    lineHeight: { small: 18, normal: 20 },
    buttonWeight: 550,
} as const;
