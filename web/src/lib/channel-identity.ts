// 按 ID 找模型服务：现有 ID 优先；没有时再找把它列为旧 ID（legacyIds）的服务。
// 老画布和老设置里存的「旧ID::模型」靠这条规则落到服务现在的条目上。
export function channelForId<T extends { id: string; legacyIds?: string[] }>(channels: readonly T[], id: string): T | undefined {
    return channels.find((channel) => channel.id === id) || (id ? channels.find((channel) => Boolean(channel.legacyIds?.includes(id))) : undefined);
}
