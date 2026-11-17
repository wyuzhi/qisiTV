import { describe, expect, test } from "bun:test";

import { assertUsableSegmentOutput, buildExtractAudioArgs, buildRemoveAudioArgs, buildSegmentTrimArgs, isFullSourceRange, MUTED_VIDEO_OUTPUT_NAME, SEGMENT_INPUT_NAME, SEGMENT_OUTPUT_NAME } from "../src/lib/canvas/canvas-video-segment-args";

describe("buildSegmentTrimArgs seek 顺序", () => {
    test("-ss 必须放在 -i 之后（输出 seek）：输入 seek 按关键帧对齐，切点会偏移最多一个 GOP", () => {
        const args = buildSegmentTrimArgs("10.5", "4");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-ss", "10.5", "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", SEGMENT_OUTPUT_NAME]);
    });
});

describe("buildExtractAudioArgs seek 顺序", () => {
    test("音频提取与裁切路径一致，同样使用输出 seek", () => {
        const args = buildExtractAudioArgs("libmp3lame", "10.5", "4");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual(["-i", SEGMENT_INPUT_NAME, "-ss", "10.5", "-t", "4", "-vn", "-c:a", "libmp3lame", "-q:a", "2", SEGMENT_OUTPUT_NAME]);
    });

    test("整段提取不带 -ss/-t 并映射首条音频流；PCM WAV 省略 VBR 质量参数", () => {
        const mp3Full = buildExtractAudioArgs("libmp3lame", "0", "6.5", "out.mp3", SEGMENT_INPUT_NAME, { fullSource: true });
        expect(mp3Full).toEqual(["-i", SEGMENT_INPUT_NAME, "-map", "0:a:0?", "-vn", "-c:a", "libmp3lame", "-q:a", "2", "out.mp3"]);
        expect(mp3Full.includes("-ss")).toBe(false);

        const wavFull = buildExtractAudioArgs("pcm_s16le", "0", "6.5", "out.wav", SEGMENT_INPUT_NAME, { fullSource: true });
        expect(wavFull).toEqual(["-i", SEGMENT_INPUT_NAME, "-map", "0:a:0?", "-vn", "-c:a", "pcm_s16le", "out.wav"]);
        expect(wavFull.includes("-q:a")).toBe(false);
    });
});

describe("isFullSourceRange", () => {
    test("起点为 0 且覆盖片长时视为整段", () => {
        expect(isFullSourceRange(0, 6041, 6041)).toBe(true);
        expect(isFullSourceRange(0, 6041, 6042)).toBe(true);
        expect(isFullSourceRange(0, 3000, 6041)).toBe(false);
        expect(isFullSourceRange(120, 6041, 6041)).toBe(false);
        expect(isFullSourceRange(0, 6041)).toBe(false);
    });
});

describe("buildRemoveAudioArgs", () => {
    test("整段去音：不 seek，复制主视频流并跳过封面图；非 MP4 兼容流可切换整段 H.264 重编码", () => {
        expect(buildRemoveAudioArgs("0", "6.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true })).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-map", "0:V:0", "-an", "-c:v", "copy", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
        expect(buildRemoveAudioArgs("0", "6.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true }).includes("-ss")).toBe(false);

        const reencode = buildRemoveAudioArgs("0", "6.04", MUTED_VIDEO_OUTPUT_NAME, { fullSource: true, fullSourceReencode: true });
        expect(reencode).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-map", "0:V:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
        expect(reencode.includes("-ss")).toBe(false);
    });

    test("部分区间去音：输出 seek 并重编码，不使用 stream copy", () => {
        const args = buildRemoveAudioArgs("1", "1.5");
        expect(args.indexOf("-ss")).toBeGreaterThan(args.indexOf("-i"));
        expect(args).toEqual([
            "-i", SEGMENT_INPUT_NAME, "-ss", "1", "-t", "1.5", "-map", "0:V:0", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", MUTED_VIDEO_OUTPUT_NAME,
        ]);
        expect(args.includes("copy")).toBe(false);
    });
});

describe("assertUsableSegmentOutput", () => {
    test("accepts a structured tiny MP4 with a video sample and mdat payload", () => {
        const tiny = isoBmff({
            handler: "vide",
            samples: 1,
            mdatPayload: 48,
        });
        expect(tiny.byteLength).toBeLessThan(4096);
        expect(() => assertUsableSegmentOutput(tiny, "video")).not.toThrow();
    });

    test("rejects the empty ffmpeg copy shell that still contains ftyp and mdat", () => {
        // Real output-seek+copy artifact: ftyp + empty mdat + moov without trak.
        const emptyShell = Uint8Array.from(Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAAhtZGF0AAAA1W1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAMAAAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAy", "base64"));
        expect(emptyShell.byteLength).toBe(261);
        expect(Buffer.from(emptyShell).includes("ftyp")).toBe(true);
        expect(Buffer.from(emptyShell).includes("mdat")).toBe(true);
        expect(() => assertUsableSegmentOutput(emptyShell, "video")).toThrow(/没有可用的视频轨道/);
    });

    test("rejects junk that only contains ftyp/mdat as substrings", () => {
        const junk = new TextEncoder().encode(`padding ftyp isom mdat ${"x".repeat(5000)}`);
        expect(junk.byteLength).toBeGreaterThan(4096);
        expect(() => assertUsableSegmentOutput(junk, "video")).toThrow(/没有可用的视频轨道/);
    });

    test("rejects ftyp+mdat without a video sample table", () => {
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 0, mdatPayload: 64 }), "video")).toThrow(/没有可用的视频轨道/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 1, mdatPayload: 0 }), "video")).toThrow(/没有可用的视频轨道/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "soun", samples: 1, mdatPayload: 64 }), "video")).toThrow(/没有可用的视频轨道/);
    });

    test("audio accepts a soun track or a WAVE/MPEG header, not an empty buffer", () => {
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "soun", samples: 1, mdatPayload: 32 }), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(waveHeader(), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), "audio")).not.toThrow();
        expect(() => assertUsableSegmentOutput(new Uint8Array(128), "audio")).toThrow(/没有可用的音轨/);
        expect(() => assertUsableSegmentOutput(isoBmff({ handler: "vide", samples: 1, mdatPayload: 32 }), "audio")).toThrow(/没有可用的音轨/);
    });
});

function isoBmff(options: { handler: "vide" | "soun"; samples: number; mdatPayload: number }) {
    const hdlr = new Uint8Array(24);
    writeAscii(hdlr, 8, options.handler);
    const stsz = new Uint8Array(12);
    new DataView(stsz.buffer).setUint32(8, options.samples);
    const stts = new Uint8Array(16);
    new DataView(stts.buffer).setUint32(4, 1);
    new DataView(stts.buffer).setUint32(8, options.samples);
    const mdat = new Uint8Array(options.mdatPayload);
    return concat([
        box("ftyp", new TextEncoder().encode("isom")),
        box("mdat", mdat),
        box("moov", box("trak", box("mdia", concat([
            box("hdlr", hdlr),
            box("minf", box("stbl", concat([box("stsz", stsz), box("stts", stts)]))),
        ])))),
    ]);
}

function waveHeader() {
    const bytes = new Uint8Array(44);
    writeAscii(bytes, 0, "RIFF");
    writeAscii(bytes, 8, "WAVE");
    writeAscii(bytes, 12, "fmt ");
    return bytes;
}

function box(type: string, payload: Uint8Array) {
    const bytes = new Uint8Array(8 + payload.byteLength);
    new DataView(bytes.buffer).setUint32(0, bytes.byteLength);
    writeAscii(bytes, 4, type);
    bytes.set(payload, 8);
    return bytes;
}

function concat(parts: Uint8Array[]) {
    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
import { assertVideoAudioProbe, canStreamCopyVideoToMp4 } from "../src/lib/canvas/canvas-video-segment-args";
import { removeAudioFromVideo } from "../src/lib/canvas/canvas-video-segment";

test("audio extraction distinguishes a silent source from encoder failure", () => {
    expect(() => assertVideoAudioProbe('{"streams":[],"format":{"duration":"15.042"}}')).toThrow("没有音轨");
    expect(() => assertVideoAudioProbe('{"streams":[{"index":1}],"format":{"duration":"3"}}')).not.toThrow();
    expect(() => assertVideoAudioProbe('{"streams":[]}')).toThrow("无法读取");
    expect(() => assertVideoAudioProbe('not-json')).toThrow("无法读取");
    expect(() => assertVideoAudioProbe('{}')).toThrow("无法读取");
});

test("canStreamCopyVideoToMp4 only allows browser-playable 8-bit yuv420p H.264/AV1", () => {
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p"}]}')).toBe(true);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"av1","pix_fmt":"yuvj420p"}]}')).toBe(true);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"hevc","pix_fmt":"yuv420p"}]}')).toBe(false);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"mpeg4","pix_fmt":"yuv420p"}]}')).toBe(false);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p10le"}]}')).toBe(false);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"mjpeg","pix_fmt":"yuvj420p"}]}')).toBe(false);
    expect(canStreamCopyVideoToMp4('{"streams":[{"codec_name":"h264"}]}')).toBe(false);
    expect(canStreamCopyVideoToMp4("not-json")).toBe(false);
});

describe("removeAudioFromVideo orchestration", () => {
    const validVideoMp4 = isoBmff({ handler: "vide", samples: 1, mdatPayload: 48 });
    const emptyVideoMp4 = isoBmff({ handler: "vide", samples: 0, mdatPayload: 48 });

    test("copies directly when ffprobe confirms H.264 yuv420p", async () => {
        const execCalls: string[][] = [];
        const deleted: string[] = [];
        const blob = await removeAudioFromVideo(
            { url: "https://example.com/v.mp4" },
            undefined,
            undefined,
            undefined,
            {
                readSourceBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
                leaseRunner: async (work) => work({
                    filePrefix: "t1-",
                    ffmpeg: {
                        writeFile: async () => true,
                        ffprobe: async () => 0,
                        readFile: async (name: string) => name.endsWith("video-probe.json")
                            ? '{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p"}]}'
                            : validVideoMp4,
                        exec: async (args: string[]) => {
                            execCalls.push(args);
                            return 0;
                        },
                        deleteFile: async (name: string) => {
                            deleted.push(name);
                            return true;
                        },
                    } as never,
                }),
            },
        );
        expect(blob.type).toBe("video/mp4");
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]).toContain("copy");
        expect(deleted).toContain("t1-video-probe.json");
    });

    test("skips stream copy and re-encodes to libx264 yuv420p when source is HEVC", async () => {
        const execCalls: string[][] = [];
        await removeAudioFromVideo(
            { url: "https://example.com/hevc.mp4" },
            undefined,
            undefined,
            undefined,
            {
                readSourceBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
                leaseRunner: async (work) => work({
                    filePrefix: "t2-",
                    ffmpeg: {
                        writeFile: async () => true,
                        ffprobe: async () => 0,
                        readFile: async (name: string) => name.endsWith("video-probe.json")
                            ? '{"streams":[{"codec_name":"hevc","pix_fmt":"yuv420p"}]}'
                            : validVideoMp4,
                        exec: async (args: string[]) => {
                            execCalls.push(args);
                            return 0;
                        },
                        deleteFile: async () => true,
                    } as never,
                }),
            },
        );
        expect(execCalls).toHaveLength(1);
        expect(execCalls[0]).toContain("libx264");
        expect(execCalls[0]).toContain("yuv420p");
    });

    test("falls back to libx264 yuv420p when H.264 stream copy yields an unusable container", async () => {
        const execCalls: string[][] = [];
        await removeAudioFromVideo(
            { url: "https://example.com/broken-copy.mp4" },
            undefined,
            undefined,
            undefined,
            {
                readSourceBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
                leaseRunner: async (work) => work({
                    filePrefix: "t3-",
                    ffmpeg: {
                        writeFile: async () => true,
                        ffprobe: async () => 0,
                        readFile: async (name: string) => {
                            if (name.endsWith("video-probe.json")) {
                                return '{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p"}]}';
                            }
                            return execCalls.length === 1 ? emptyVideoMp4 : validVideoMp4;
                        },
                        exec: async (args: string[]) => {
                            execCalls.push(args);
                            return 0;
                        },
                        deleteFile: async () => true,
                    } as never,
                }),
            },
        );
        expect(execCalls).toHaveLength(2);
        expect(execCalls[0]).toContain("copy");
        expect(execCalls[1]).toContain("libx264");
        expect(execCalls[1]).toContain("yuv420p");
    });
});
