import { http } from "@/services/api/request";

/** 后端读取模型目录、按接口格式发文本请求时实际用的地址；text 以请求里传的接口格式为键。 */
export type ChannelRequestUrls = { catalog: string; text: Record<string, string> };

export type ChannelRequestUrlsInput = { baseUrl: string; apiFormat?: string; protocols: string[] };

export async function fetchChannelRequestUrls(input: ChannelRequestUrlsInput, signal?: AbortSignal): Promise<ChannelRequestUrls> {
    const data = await http.post<Partial<ChannelRequestUrls> | null>("/ai/request-urls", input, { signal });
    return { catalog: typeof data?.catalog === "string" ? data.catalog : "", text: data?.text && typeof data.text === "object" ? data.text : {} };
}
