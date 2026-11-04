import { describe, expect, it } from "bun:test";

import {
    decodeXmlEntities,
    extractScriptDocumentText,
    extractWordDocumentXmlText,
    isDocxDocumentFile,
    isScriptDocumentFile,
    stripScriptDocumentExtension,
} from "./script-document-import";

async function deflateRawBytes(input: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([input]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildSynthesizedDocxBuffer(
    documentXml: string,
    options: { method?: 0 | 8; omitCentralDirectory?: boolean } = {},
): Promise<ArrayBuffer> {
    const method = options.method ?? 8;
    const encoder = new TextEncoder();
    const rawEntries = [
        {
            name: "[Content_Types].xml",
            raw: encoder.encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`),
        },
        {
            name: "word/document.xml",
            raw: encoder.encode(documentXml),
        },
    ];

    const localParts: Uint8Array[] = [];
    const centralParts: Uint8Array[] = [];
    let offset = 0;

    for (const entry of rawEntries) {
        const nameBytes = encoder.encode(entry.name);
        const payload = method === 8 ? await deflateRawBytes(entry.raw) : entry.raw;

        const localHeader = new Uint8Array(30 + nameBytes.length + payload.length);
        const localView = new DataView(localHeader.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, 0, true);
        localView.setUint16(8, method, true);
        localView.setUint32(18, payload.length, true);
        localView.setUint32(22, entry.raw.length, true);
        localView.setUint16(26, nameBytes.length, true);
        localView.setUint16(28, 0, true);
        localHeader.set(nameBytes, 30);
        localHeader.set(payload, 30 + nameBytes.length);
        localParts.push(localHeader);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralHeader.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, 0, true);
        centralView.setUint16(10, method, true);
        centralView.setUint32(20, payload.length, true);
        centralView.setUint32(24, entry.raw.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint32(42, offset, true);
        centralHeader.set(nameBytes, 46);
        centralParts.push(centralHeader);

        offset += localHeader.length;
    }

    if (options.omitCentralDirectory) {
        return new Blob(localParts).arrayBuffer();
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, rawEntries.length, true);
    eocdView.setUint16(10, rawEntries.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    return new Blob([...localParts, ...centralParts, eocd]).arrayBuffer();
}

describe("script-document-import", () => {
    it("matches supported script document filenames case-insensitively", () => {
        expect(isScriptDocumentFile({ name: "episode-01.docx" })).toBe(true);
        expect(isScriptDocumentFile({ name: "EPISODE-02.DOCX" })).toBe(true);
        expect(isScriptDocumentFile({ name: "outline.txt" })).toBe(true);
        expect(isScriptDocumentFile({ name: "scenes.md" })).toBe(true);
        expect(isScriptDocumentFile({ name: "notes.markdown" })).toBe(true);
        expect(isScriptDocumentFile({ name: "legacy.doc" })).toBe(false);
        expect(isScriptDocumentFile({ name: "poster.png", type: "image/png" })).toBe(false);
        expect(isDocxDocumentFile({ name: "script.DOCX" })).toBe(true);
        expect(isDocxDocumentFile({ name: "script.txt" })).toBe(false);
    });

    it("strips document extensions cleanly for titles", () => {
        expect(stripScriptDocumentExtension("第一集_雨夜追凶.docx")).toBe("第一集_雨夜追凶");
        expect(stripScriptDocumentExtension("/path/to/分镜脚本.MD")).toBe("分镜脚本");
        expect(stripScriptDocumentExtension("   ")).toBe("");
    });

    it("decodes XML entities and formats Word XML paragraphs and tables", () => {
        expect(decodeXmlEntities("A &amp; B &lt;3&gt; &quot;Hi&quot; &apos;OK&apos; &#65; &#x4E2D;")).toBe(
            "A & B <3> \"Hi\" 'OK' A 中",
        );

        const xml = [
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
            `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`,
            `<w:p><w:r><w:t>第一场：天台夜雨</w:t></w:r></w:p>`,
            `<w:p><w:r><w:t>林默站在霓虹灯下</w:t><w:br/><w:t>手里握着旧怀表 &amp; 录音笔。</w:t></w:r></w:p>`,
            `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>镜号1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>全景推进</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
            `</w:body></w:document>`,
        ].join("");

        expect(extractWordDocumentXmlText(xml)).toBe(
            "第一场：天台夜雨\n林默站在霓虹灯下\n手里握着旧怀表 & 录音笔。\n镜号1\t全景推进",
        );
    });

    it("extracts UTF-8 text and title from .txt and .md files", async () => {
        const mdFile = new File(
            ["# 第一幕\r\n\r\n\r\n雨夜街道，特写镜头。\r\n\r\n第二幕：追逐\r\n"],
            "都市悬疑分镜.md",
            { type: "text/markdown" },
        );
        const result = await extractScriptDocumentText(mdFile);
        expect(result.title).toBe("都市悬疑分镜");
        expect(result.content).toBe("# 第一幕\n\n雨夜街道，特写镜头。\n\n第二幕：追逐");
    });

    it("extracts text from a stored (method 0) .docx ZIP archive", async () => {
        const xml = `<w:document><w:body><w:p><w:r><w:t>第1集 开场</w:t></w:r></w:p><w:p><w:r><w:t>主角推门而入。</w:t></w:r></w:p></w:body></w:document>`;
        const buffer = await buildSynthesizedDocxBuffer(xml, { method: 0 });
        const file = new File([buffer], "第一集剧本.docx", {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });

        const result = await extractScriptDocumentText(file);
        expect(result.title).toBe("第一集剧本");
        expect(result.content).toBe("第1集 开场\n主角推门而入。");
    });

    it("extracts text from a deflate-raw compressed (method 8) .docx ZIP archive", async () => {
        const xml = [
            `<w:document><w:body>`,
            `<w:p><w:r><w:t>场景一：咖啡馆（日 / 内）</w:t></w:r></w:p>`,
            `<w:p><w:r><w:t>对白：&quot;你终于来了。&quot;</w:t><w:tab/><w:t>（低声）</w:t></w:r></w:p>`,
            `</w:body></w:document>`,
        ].join("");
        const buffer = await buildSynthesizedDocxBuffer(xml, { method: 8 });
        const result = await extractScriptDocumentText(buffer, "咖啡馆对手戏.docx");

        expect(result.title).toBe("咖啡馆对手戏");
        expect(result.content).toBe(`场景一：咖啡馆（日 / 内）\n对白："你终于来了。"\t（低声）`);
    });

    it("falls back to local file headers when central directory is absent", async () => {
        const xml = `<w:document><w:body><w:p><w:r><w:t>本地头部解析成功</w:t></w:r></w:p></w:body></w:document>`;
        const buffer = await buildSynthesizedDocxBuffer(xml, { method: 8, omitCentralDirectory: true });
        const result = await extractScriptDocumentText(buffer, "fallback.docx");
        expect(result.title).toBe("fallback");
        expect(result.content).toBe("本地头部解析成功");
    });
});
