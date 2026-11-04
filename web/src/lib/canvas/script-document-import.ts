import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeTypeId, type Position } from "@/types/canvas";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DOCX_DOCUMENT_XML_PATH = "word/document.xml";

export const SCRIPT_DOCUMENT_ACCEPT = ".docx,.txt,.md,.markdown,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isDocxDocumentFile(file: { name: string; type?: string }): boolean {
    const name = String(file?.name || "").trim();
    const type = String(file?.type || "").trim().toLowerCase();
    return /\.docx$/i.test(name) || type === DOCX_MIME_TYPE;
}

export function isScriptDocumentFile(file: { name: string; type?: string }): boolean {
    const name = String(file?.name || "").trim();
    const type = String(file?.type || "").trim().toLowerCase();
    if (/\.doc$/i.test(name)) return false;
    return /\.(?:docx|txt|md|markdown)$/i.test(name) || type === "text/plain" || type === "text/markdown" || type === DOCX_MIME_TYPE;
}

export function resolveScriptOrUploadNodeType(
    file: { name: string; type?: string },
    fallbackType: CanvasNodeTypeId | null,
): CanvasNodeTypeId | null {
    if (fallbackType) return fallbackType;
    return isScriptDocumentFile(file) ? CanvasNodeType.Text : null;
}

export async function createScriptDocumentUploadPlaceholder(
    id: string,
    file: File,
    position: Position,
    fallback: () => Promise<CanvasNodeData>,
): Promise<CanvasNodeData> {
    if (isDocxDocumentFile(file)) {
        const size = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        return {
            id,
            type: CanvasNodeType.Text,
            title: stripScriptDocumentExtension(file.name) || file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: { fileUpload: "uploading", bytes: file.size, mimeType: file.type || DOCX_MIME_TYPE },
        };
    }
    return fallback();
}

export function stripScriptDocumentExtension(fileName?: string): string {
    const baseName = String(fileName || "")
        .trim()
        .replace(/^.*[\\/]/, "");
    if (!baseName) return "";
    return baseName.replace(/\.(?:docx?|txt|md|markdown)$/i, "").trim();
}

function deriveScriptDocumentTitle(fileName: string | undefined, content: string): string {
    const fromName = stripScriptDocumentExtension(fileName);
    if (fromName) return fromName;
    const firstLine = content
        .split("\n")
        .map((line) => line.trim().replace(/^#{1,6}\s*/, "").replace(/^[《〈【“"']+|[》〉】”"']+$/g, "").trim())
        .find(Boolean);
    return firstLine ? firstLine.slice(0, 40) : "导入剧本";
}

function normalizeScriptParagraphs(raw: string): string {
    return raw
        .replace(/^\uFEFF/, "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \f\v]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export function decodeXmlEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => {
            const code = Number.parseInt(hex, 16);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        })
        .replace(/&#(\d+);/g, (match, dec: string) => {
            const code = Number.parseInt(dec, 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
        })
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

export function extractWordDocumentXmlText(xml: string): string {
    const withBreaks = xml
        .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/gi, "")
        .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, "")
        .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
        .replace(/<\/w:p>\s*(?=<\/w:tc>)/gi, "")
        .replace(/<\/w:tc>/gi, "\t")
        .replace(/\t+(?=<\/w:tr>)/gi, "")
        .replace(/<\/w:tr>/gi, "\n")
        .replace(/<(?:w:br|w:cr)\b[^>]*\/?>/gi, "\n")
        .replace(/<\/w:p>/gi, "\n")
        .replace(/<[^>]+>/g, "");
    return normalizeScriptParagraphs(decodeXmlEntities(withBreaks));
}

function hasZipSignature(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 4) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0, true) === ZIP_LOCAL_FILE_HEADER_SIGNATURE;
}

type ZipEntrySlice = {
    compressionMethod: number;
    compressedData: Uint8Array;
};

function findEntryViaCentralDirectory(bytes: Uint8Array, view: DataView, targetPath: string): ZipEntrySlice | null {
    const minEocdSize = 22;
    if (bytes.byteLength < minEocdSize) return null;
    const maxCommentLength = Math.min(0xffff, bytes.byteLength - minEocdSize);
    let eocdOffset = -1;
    for (let commentLen = 0; commentLen <= maxCommentLength; commentLen += 1) {
        const candidate = bytes.byteLength - minEocdSize - commentLen;
        if (view.getUint32(candidate, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
            eocdOffset = candidate;
            break;
        }
    }
    if (eocdOffset < 0) return null;
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);
    const decoder = new TextDecoder("utf-8");
    let offset = centralDirOffset;
    for (let index = 0; index < totalEntries && offset + 46 <= bytes.byteLength; index += 1) {
        if (view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) break;
        const compressionMethod = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const localHeaderOffset = view.getUint32(offset + 42, true);
        const nameEnd = offset + 46 + nameLength;
        if (nameEnd > bytes.byteLength) break;
        const entryName = decoder.decode(bytes.subarray(offset + 46, nameEnd)).replace(/\\/g, "/");
        if (entryName === targetPath) {
            if (localHeaderOffset + 30 > bytes.byteLength || view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
                break;
            }
            const localNameLength = view.getUint16(localHeaderOffset + 26, true);
            const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
            const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
            const dataEnd = dataStart + compressedSize;
            if (dataEnd > bytes.byteLength) break;
            return {
                compressionMethod,
                compressedData: bytes.subarray(dataStart, dataEnd),
            };
        }
        offset = nameEnd + extraLength + commentLength;
    }
    return null;
}

function findEntryViaLocalHeaders(bytes: Uint8Array, view: DataView, targetPath: string): ZipEntrySlice | null {
    const decoder = new TextDecoder("utf-8");
    let offset = 0;
    while (offset + 30 <= bytes.byteLength) {
        const signature = view.getUint32(offset, true);
        if (signature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) break;
        const compressionMethod = view.getUint16(offset + 8, true);
        const compressedSize = view.getUint32(offset + 18, true);
        const nameLength = view.getUint16(offset + 26, true);
        const extraLength = view.getUint16(offset + 28, true);
        const nameStart = offset + 30;
        const nameEnd = nameStart + nameLength;
        const dataStart = nameEnd + extraLength;
        const dataEnd = dataStart + compressedSize;
        if (nameEnd > bytes.byteLength || dataEnd > bytes.byteLength) break;
        const entryName = decoder.decode(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, "/");
        if (entryName === targetPath) {
            return {
                compressionMethod,
                compressedData: bytes.subarray(dataStart, dataEnd),
            };
        }
        offset = dataEnd;
    }
    return null;
}

async function decompressZipEntry(entry: ZipEntrySlice): Promise<Uint8Array> {
    if (entry.compressionMethod === 0) {
        return entry.compressedData;
    }
    if (entry.compressionMethod === 8) {
        if (typeof DecompressionStream === "undefined") {
            throw new Error("当前环境不支持解压 DOCX 文档");
        }
        const stream = new Blob([entry.compressedData]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`不支持的 DOCX 压缩算法（method=${entry.compressionMethod}）`);
}

async function extractDocxBytesText(bytes: Uint8Array): Promise<string> {
    if (!hasZipSignature(bytes)) {
        throw new Error("无效的 DOCX 文件格式");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entry = findEntryViaCentralDirectory(bytes, view, DOCX_DOCUMENT_XML_PATH) ?? findEntryViaLocalHeaders(bytes, view, DOCX_DOCUMENT_XML_PATH);
    if (!entry) {
        throw new Error("DOCX 文件中未找到 word/document.xml 正文");
    }
    const xmlBytes = await decompressZipEntry(entry);
    const xml = new TextDecoder("utf-8").decode(xmlBytes);
    return extractWordDocumentXmlText(xml);
}

async function readInputBytes(input: File | (Blob & { name?: string }) | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    return new Uint8Array(await input.arrayBuffer());
}

export async function extractScriptDocumentText(
    file: File | (Blob & { name?: string }) | ArrayBuffer | Uint8Array,
    fileName?: string,
): Promise<{ title: string; content: string }> {
    const resolvedName =
        fileName?.trim() ||
        (typeof file === "object" && file !== null && "name" in file && typeof file.name === "string" ? file.name.trim() : "");
    const resolvedType =
        typeof file === "object" && file !== null && "type" in file && typeof file.type === "string" ? file.type.trim() : "";
    if (/\.doc$/i.test(resolvedName)) {
        throw new Error("暂不支持旧版 .doc 格式，请先另存为 .docx 或 .txt 文件");
    }
    const bytes = await readInputBytes(file);
    if (bytes.byteLength === 0) {
        throw new Error("剧本文件为空，请选择包含正文的文件");
    }
    const isDocx = isDocxDocumentFile({ name: resolvedName, type: resolvedType }) || hasZipSignature(bytes);
    const content = isDocx
        ? await extractDocxBytesText(bytes)
        : normalizeScriptParagraphs(new TextDecoder("utf-8").decode(bytes));
    if (!content) {
        throw new Error("剧本文件中没有可导入的文本内容");
    }
    return {
        title: deriveScriptDocumentTitle(resolvedName, content),
        content,
    };
}
