import { ownedResourceIdFromMediaRef, resourceStorageKey } from "@/services/api/resources";
import { getMediaBlob } from "@/services/file-storage";
import { AUDIO_OUTPUT_NAME, assertUsableSegmentOutput, assertVideoAudioProbe, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, buildVideoCropArgs, canStreamCopyVideoToMp4, CROP_OUTPUT_NAME, isFullSourceRange, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME, WAV_OUTPUT_NAME } from "./canvas-video-segment-args";
import { withFFmpegLease } from "./canvas-ffmpeg-session";
import { videoFrameFetchCredentials } from "./canvas-video-frame";

export type VideoSegmentRange = {
    startMs: number;
    endMs: number;
};

export type VideoSegmentSource = {
    url?: string;
    storageKey?: string;
};

export type VideoSegmentProgress = {
    phase: "loading" | "reading" | "encoding";
    progress: number;
};

const INPUT_NAME = SEGMENT_INPUT_NAME;
const OUTPUT_NAME = SEGMENT_OUTPUT_NAME;

function assertValidRange(range: VideoSegmentRange, durationMs?: number) {
    const startMs = Math.max(0, Math.round(range.startMs));
    const endMs = Math.round(range.endMs);
    if (endMs <= startMs) throw new Error("片段结束时间必须晚于开始时间");
    if (durationMs !== undefined && endMs > Math.round(durationMs)) throw new Error("片段结束时间超过视频时长");
}

async function readVideoSourceBlob(source: VideoSegmentSource) {
    const ownedId = ownedResourceIdFromMediaRef(source.storageKey, source.url);
    const effectiveKey = source.storageKey || (ownedId ? resourceStorageKey(ownedId) : "");
    if (effectiveKey) {
        const stored = await getMediaBlob(effectiveKey);
        if (stored) return stored;
    }
    if (source.url) {
        const response = await fetch(source.url, { credentials: videoFrameFetchCredentials(source.url) });
        if (!response.ok) throw new Error(`视频资源请求失败（${response.status}）`);
        return response.blob();
    }
    throw new Error("找不到视频素材，请重新上传后再操作");
}

function leaseProgress(onProgress?: (progress: VideoSegmentProgress) => void) {
    return ({ phase, progress }: { phase: "loading" | "reading" | "encoding"; progress: number }) => {
        onProgress?.({ phase: phase === "loading" ? "loading" : "reading", progress });
    };
}

type SegmentJobDeps = {
    leaseRunner?: typeof withFFmpegLease;
    readSourceBlob?: (source: VideoSegmentSource) => Promise<Blob>;
};

type SegmentJobOptions = SegmentJobDeps & {
    outputName?: string;
    extraCleanupFiles?: (filePrefix: string) => string[];
    allowPrimary?: (ffmpeg: Parameters<Parameters<typeof withFFmpegLease>[0]>[0]["ffmpeg"], inputName: string, filePrefix: string) => Promise<boolean>;
    buildFallbackArgs?: (startSec: string, durationSec: string, inputName: string, outputName: string) => string[];
};

async function runSegmentJob(
    source: VideoSegmentSource,
    range: VideoSegmentRange | undefined,
    durationMs: number | undefined,
    buildArgs: (startSec: string, durationSec: string, inputName: string, outputName: string) => string[],
    onProgress?: (progress: VideoSegmentProgress) => void,
    options?: SegmentJobOptions,
) {
    if (range) assertValidRange(range, durationMs);
    const leaseRunner = options?.leaseRunner ?? withFFmpegLease;
    const readBlob = options?.readSourceBlob ?? readVideoSourceBlob;
    const outputName = options?.outputName ?? OUTPUT_NAME;
    return leaseRunner(async ({ ffmpeg, filePrefix }) => {
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const resolvedOutput = `${filePrefix}${outputName}`;
        const blob = await readBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, new Uint8Array(await blob.arrayBuffer()));
        const startSec = range ? String(range.startMs / 1000) : "0";
        const durationSec = range ? String((range.endMs - range.startMs) / 1000) : "0";
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const runPrimary = options?.allowPrimary ? await options.allowPrimary(ffmpeg, inputName, filePrefix) : true;
            let exitCode = 1;
            let output: Uint8Array | string | undefined;
            if (runPrimary) {
                exitCode = await ffmpeg.exec(["-y", ...buildArgs(startSec, durationSec, inputName, resolvedOutput)]);
                if (exitCode === 0) {
                    try {
                        output = await ffmpeg.readFile(resolvedOutput);
                        assertUsableSegmentOutput(output, "video");
                    } catch (err) {
                        if (!options?.buildFallbackArgs) throw err;
                        output = undefined;
                        exitCode = 1;
                    }
                }
            }
            if ((exitCode !== 0 || output === undefined) && options?.buildFallbackArgs) {
                await ffmpeg.deleteFile(resolvedOutput).catch(() => undefined);
                exitCode = await ffmpeg.exec(["-y", ...options.buildFallbackArgs(startSec, durationSec, inputName, resolvedOutput)]);
                if (exitCode === 0) {
                    output = await ffmpeg.readFile(resolvedOutput);
                    assertUsableSegmentOutput(output, "video");
                }
            }
            if (exitCode !== 0 || output === undefined) throw new Error("媒体处理失败，请确认视频编码格式兼容");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: "video/mp4" });
        } finally {
            const cleanup = [inputName, `${filePrefix}${OUTPUT_NAME}`, resolvedOutput, ...(options?.extraCleanupFiles?.(filePrefix) ?? [])];
            await Promise.all(cleanup.map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}

/** 按片段范围截取视频，输出统一编码 MP4（复用时间线 trim 的参数模板）。 */
export async function trimVideoSegment(source: VideoSegmentSource, range: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    return runSegmentJob(source, range, durationMs, (startSec, durationSec, inputName, outputName) => buildSegmentTrimArgs(startSec, durationSec, inputName, outputName), onProgress);
}

/** 从视频中移除音轨，保留画面并输出独立无声视频（整段仅对浏览器可直播的 H.264/AV1 8-bit yuv420p 流拷贝，HEVC/MPEG-4/MJPEG/10-bit 自动走 H.264 yuv420p 重编码）。 */
export async function removeAudioFromVideo(
    source: VideoSegmentSource,
    range?: VideoSegmentRange,
    durationMs?: number,
    onProgress?: (progress: VideoSegmentProgress) => void,
    deps?: SegmentJobDeps,
) {
    const fullSource = !range || isFullSourceRange(range.startMs, range.endMs, durationMs);
    if (!fullSource) {
        return runSegmentJob(
            source,
            range,
            durationMs,
            (startSec, durationSec, inputName, outputName) => buildRemoveAudioArgs(startSec, durationSec, outputName, { fullSource: false, inputName }),
            onProgress,
            { ...deps, outputName: MUTED_VIDEO_OUTPUT_NAME },
        );
    }
    return runSegmentJob(
        source,
        range,
        durationMs,
        (_startSec, _durationSec, inputName, outputName) => buildRemoveAudioArgs("0", "0", outputName, { fullSource: true, inputName }),
        onProgress,
        {
            ...deps,
            outputName: MUTED_VIDEO_OUTPUT_NAME,
            extraCleanupFiles: (filePrefix) => [`${filePrefix}video-probe.json`],
            allowPrimary: async (ffmpeg, inputName, filePrefix) => {
                const probeName = `${filePrefix}video-probe.json`;
                const probeCode = await ffmpeg.ffprobe(["-v", "error", "-select_streams", "V:0", "-show_entries", "stream=codec_name,pix_fmt", "-of", "json", inputName, "-o", probeName]).catch(() => 1);
                if (probeCode !== 0 && probeCode !== -1) return false;
                const rawProbe = await ffmpeg.readFile(probeName).catch(() => "");
                return canStreamCopyVideoToMp4(typeof rawProbe === "string" ? rawProbe : new TextDecoder().decode(rawProbe));
            },
            buildFallbackArgs: (_startSec, _durationSec, inputName, outputName) => buildRemoveAudioArgs("0", "0", outputName, { fullSource: true, fullSourceReencode: true, inputName }),
        },
    );
}

/** 从视频片段提取声音；输出上游参考音频兼容的 MP3（不支持时自动回退 WAV，不产出上游拒收的 M4A）。 */
export async function extractVideoAudio(source: VideoSegmentSource, range?: VideoSegmentRange, durationMs?: number, onProgress?: (progress: VideoSegmentProgress) => void) {
    if (range) assertValidRange(range, durationMs);
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const audioName = `${filePrefix}${AUDIO_OUTPUT_NAME}`;
        const wavName = `${filePrefix}${WAV_OUTPUT_NAME}`;
        const probeName = `${filePrefix}audio-probe.json`;
        const blob = await readVideoSourceBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, await fetchFile(blob));
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const probeCode = await ffmpeg.ffprobe(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index:format=duration", "-of", "json", inputName, "-o", probeName]);
            // The bundled ffprobe writes valid JSON while leaving ret at -1.
            // Validate its output and duration; do not mistake that sentinel for an encoder failure.
            if (probeCode !== 0 && probeCode !== -1) throw new Error("无法读取视频音轨信息，请检查素材是否完整");
            const probe = await ffmpeg.readFile(probeName);
            const probedDurationMs = assertVideoAudioProbe(typeof probe === "string" ? probe : new TextDecoder().decode(probe));
            const effectiveRange = range ?? { startMs: 0, endMs: probedDurationMs };
            const fullSource = !range || isFullSourceRange(effectiveRange.startMs, effectiveRange.endMs, durationMs ?? probedDurationMs);
            const startSec = String(effectiveRange.startMs / 1000);
            const durationSec = String(Math.max(0.001, (effectiveRange.endMs - effectiveRange.startMs) / 1000));
            const args = (audioCodec: string, outputName = audioName) => buildExtractAudioArgs(audioCodec, startSec, durationSec, outputName, inputName, { fullSource });
            let outputName = audioName;
            let outputType = "audio/mpeg";
            let exitCode = await ffmpeg.exec(["-y", ...args("libmp3lame")]);
            if (exitCode !== 0) exitCode = await ffmpeg.exec(["-y", ...args("mp3")]);
            if (exitCode !== 0) {
                // The bundled core may omit both MP3 encoders. PCM/WAV is broadly
                // available and accepted by all reference-audio upload endpoints.
                outputName = wavName;
                outputType = "audio/wav";
                exitCode = await ffmpeg.exec(["-y", ...args("pcm_s16le", outputName)]);
            }
            if (exitCode !== 0) throw new Error("音频提取失败：当前 FFmpeg 内核不支持可用的音频编码");
            const output = await ffmpeg.readFile(outputName);
            assertUsableSegmentOutput(output, "audio");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: outputType });
        } finally {
            await Promise.all([inputName, `${filePrefix}${OUTPUT_NAME}`, audioName, wavName, probeName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}

export type VideoCropRect = { x: number; y: number; width: number; height: number };

/** 按源视频像素裁切画面，保留原音轨并输出新视频。 */
export async function cropVideo(source: VideoSegmentSource, crop: VideoCropRect, onProgress?: (progress: VideoSegmentProgress) => void) {
    return withFFmpegLease(async ({ ffmpeg, filePrefix }) => {
        const { fetchFile } = await import("@ffmpeg/util");
        const inputName = `${filePrefix}${INPUT_NAME}`;
        const cropName = `${filePrefix}${CROP_OUTPUT_NAME}`;
        const blob = await readVideoSourceBlob(source);
        onProgress?.({ phase: "reading", progress: 45 });
        await ffmpeg.writeFile(inputName, await fetchFile(blob));
        onProgress?.({ phase: "encoding", progress: 55 });
        try {
            const exitCode = await ffmpeg.exec(["-y", ...buildVideoCropArgs(crop.x, crop.y, crop.width, crop.height, inputName, cropName)]);
            if (exitCode !== 0) throw new Error("视频画面裁切失败，请确认视频编码格式兼容");
            const output = await ffmpeg.readFile(cropName);
            assertUsableSegmentOutput(output, "video");
            onProgress?.({ phase: "encoding", progress: 100 });
            return new Blob([output as BlobPart], { type: "video/mp4" });
        } finally {
            await Promise.all([inputName, cropName].map((file) => ffmpeg.deleteFile(file).catch(() => undefined)));
        }
    }, { onProgress: leaseProgress(onProgress) });
}
