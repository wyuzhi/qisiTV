/** Read media through the installed runtime transport. Only the exact paired
 * loopback API receives its session header; redirects cannot forward it. */
export async function readAuthenticatedMediaBlob(url: string, signal?: AbortSignal) {
    const response = await fetch(url, { signal, credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
    return response.blob();
}
