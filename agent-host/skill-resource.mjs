// Go owns both installed packages and the active version selection. The
// transcript records explicit selections; an official section reconstructs
// active rules after compaction and process restart.
import { section } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const fail = (reason) => Object.assign(new Error(reason), { reason });
const hashPattern = /^[a-f0-9]{64}$/;
export const SKILL_CATALOG_LIMIT = 50;
export const SKILL_DESCRIPTION_LIMIT = 300;
export const SKILL_PAGE_MAX_LINES = 2000;
export const SKILL_PAGE_MAX_BYTES = 50 * 1024;

export function normalizeSkillPins(values = []) {
  if (!Array.isArray(values)) throw fail('invalid_skill_selection');
  const seen = new Set();
  return values.map((value) => {
    if (!value || typeof value.skillId !== 'string' || !value.skillId.trim() ||
      typeof value.versionId !== 'string' || !value.versionId.trim() || !hashPattern.test(value.contentHash || '') || seen.has(value.skillId)) {
      throw fail('invalid_skill_selection');
    }
    seen.add(value.skillId);
    return { skillId: value.skillId, versionId: value.versionId, contentHash: value.contentHash };
  }).sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export function sameSkillPin(left, right) {
  return left?.skillId === right?.skillId && left?.versionId === right?.versionId && left?.contentHash === right?.contentHash;
}

function checkResource(pin, resource) {
  if (!sameSkillPin(pin, resource?.pin) || typeof resource.instruction !== 'string' || (!resource.instruction.trim() && !resource.pagination?.truncated)) {
    throw fail('skill_version_unavailable');
  }
  if (!Array.isArray(resource.files) || !Array.isArray(resource.unsupportedCapabilities)) throw fail('skill_package_unreadable');
  return resource;
}

export async function loadPinnedSkills({ pins = [], readVersion, signal } = {}) {
  const selected = normalizeSkillPins(pins);
  if (!selected.length) return [];
  if (typeof readVersion !== 'function') throw fail('skill_service_unavailable');
  const resources = [];
  for (const pin of selected) {
    if (signal?.aborted) throw signal.reason || fail('aborted');
    const resource = checkResource(pin, await readVersion(pin, signal));
    resources.push(resource);
  }
  return resources;
}

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function stripSkillFrontmatter(raw) {
  const text = String(raw ?? '');
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)*/.exec(text);
  if (!match) return { body: text, strippedLines: 0 };
  const rest = text.slice(match[0].length);
  if (!rest.trim()) return { body: text, strippedLines: 0 };
  const strippedLines = match[0].split(/\r?\n/).length - 1;
  return { body: rest, strippedLines };
}

function splitSkillLines(source) {
  if (!source.length) return [];
  const lines = source.split('\n');
  if (source.endsWith('\n')) lines.pop();
  return lines;
}

function formatSkillPaginationFooter(pagination, { skillId = '', path = '', explicitRange = false, shownBytes = 0 } = {}) {
  if (!pagination) return '';
  const { startLine, endLine, totalLines, truncated, firstLineExceedsLimit, firstLineBytes } = pagination;
  const targetHint = [skillId ? `skillId="${skillId}"` : '', path ? `path="${path}"` : ''].filter(Boolean).join(', ');
  if (totalLines === 0 || startLine > totalLines) {
    return `[文件共 ${totalLines} 行，请求的 offset=${startLine} 已超出末尾。]`;
  }
  if (firstLineExceedsLimit) {
    const nextHint = startLine < totalLines
      ? `如需继续阅读后续行，请传 offset=${startLine + 1} 调用 skill_file${targetHint ? `（${targetHint}）` : ''}。`
      : '';
    return `\n\n[第 ${startLine} 行共 ${firstLineBytes} 字节，超出单页上限，当前仅展示前 ${shownBytes} 字节（同行超出部分不再展开；文件共 ${totalLines} 行）。${nextHint}]`;
  }
  if (truncated) {
    return `\n\n[当前显示第 ${startLine}-${endLine} 行（共 ${totalLines} 行）。如需继续阅读后续内容，请传 offset=${endLine + 1} 调用 skill_file${targetHint ? `（${targetHint}）` : ''}。]`;
  }
  if (explicitRange && startLine > 1) {
    return `\n\n[当前显示第 ${startLine}-${endLine} 行（共 ${totalLines} 行，已到文件末尾）。]`;
  }
  return '';
}

export function paginateSkillText(text, {
  offset,
  limit,
  maxLines = SKILL_PAGE_MAX_LINES,
  maxBytes = SKILL_PAGE_MAX_BYTES,
  skillId = '',
  path = '',
  baseLineOffset = 0,
} = {}) {
  const source = String(text ?? '');
  const explicitRange = offset !== undefined || limit !== undefined;
  const lines = splitSkillLines(source);
  const totalLines = lines.length;
  const totalFileLines = totalLines + baseLineOffset;
  if (!explicitRange && totalLines <= maxLines && Buffer.byteLength(source, 'utf8') <= maxBytes) {
    return { content: source, truncated: false, startLine: 1 + baseLineOffset, endLine: totalFileLines, totalLines: totalFileLines };
  }
  const startIndex = Math.max(0, (Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 1) - 1);
  const startFileLine = startIndex + 1 + baseLineOffset;
  if (totalLines === 0 || startIndex >= totalLines) {
    const pagination = { startLine: startFileLine, endLine: totalFileLines, totalLines: totalFileLines, truncated: false };
    return {
      content: formatSkillPaginationFooter(pagination, { skillId, path, explicitRange }),
      ...pagination,
    };
  }
  const requestedLines = limit !== undefined && Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(maxLines, Math.trunc(Number(limit))))
    : maxLines;
  const pageMaxBytes = Math.max(16, maxBytes);
  const picked = [];
  let bytes = 0;
  let firstLineExceedsLimit = false;
  let firstLineBytes = 0;
  for (let i = startIndex; i < totalLines && picked.length < requestedLines; i += 1) {
    const rawLine = lines[i];
    const lineBuf = Buffer.from(rawLine, 'utf8');
    const sepBytes = picked.length > 0 ? 1 : 0;
    if (bytes + sepBytes + lineBuf.length > pageMaxBytes) {
      if (picked.length === 0) {
        let endByte = Math.min(pageMaxBytes, lineBuf.length);
        while (endByte > 0 && (lineBuf[endByte] & 0xc0) === 0x80) endByte -= 1;
        picked.push(lineBuf.subarray(0, endByte).toString('utf8'));
        bytes = endByte;
        firstLineExceedsLimit = true;
        firstLineBytes = lineBuf.length;
      }
      break;
    }
    picked.push(rawLine);
    bytes += sepBytes + lineBuf.length;
  }
  const endFileLine = startIndex + picked.length + baseLineOffset;
  const truncated = firstLineExceedsLimit || (startIndex + picked.length < totalLines);
  const pagination = {
    startLine: startFileLine,
    endLine: endFileLine,
    totalLines: totalFileLines,
    truncated,
    ...(firstLineExceedsLimit ? { firstLineExceedsLimit: true, firstLineBytes } : {}),
  };
  const body = picked.join('\n');
  const footer = formatSkillPaginationFooter(pagination, { skillId, path, explicitRange, shownBytes: bytes });
  return { content: body + footer, ...pagination };
}

export function renderSkillPage(text, {
  pagination,
  offset,
  limit,
  maxLines = SKILL_PAGE_MAX_LINES,
  maxBytes = SKILL_PAGE_MAX_BYTES,
  skillId = '',
  path = '',
  baseLineOffset = 0,
} = {}) {
  if (!pagination || typeof pagination !== 'object') {
    return paginateSkillText(text, { offset, limit, maxLines, maxBytes, skillId, path, baseLineOffset });
  }
  const explicitRange = offset !== undefined || limit !== undefined;
  const rawStartLine = Number(pagination.startLine || 1);
  const effective = {
    startLine: rawStartLine === 1 ? 1 + baseLineOffset : rawStartLine,
    endLine: Number(pagination.endLine || 0),
    totalLines: Number(pagination.totalLines || 0),
    truncated: Boolean(pagination.truncated),
    ...(pagination.firstLineExceedsLimit ? { firstLineExceedsLimit: true, firstLineBytes: Number(pagination.firstLineBytes || 0) } : {}),
  };
  if (effective.totalLines === 0 || rawStartLine > effective.totalLines) {
    return {
      content: formatSkillPaginationFooter(effective, { skillId, path, explicitRange }),
      ...effective,
    };
  }
  const body = String(text ?? '');
  const shownBytes = Buffer.byteLength(body, 'utf8');
  const footer = formatSkillPaginationFooter(effective, { skillId, path, explicitRange, shownBytes });
  return { content: body + footer, ...effective };
}

// Official shape: `<skill name location>\nReferences are relative to ...\n\n{body}\n</skill>`.
// The pin replaces the location; the guidance replaces the reference line.
export function formatSkillBlock(resource) {
  const { pin } = resource;
  const files = resource.files.map((file) => file?.path).filter(Boolean);
  const entryPath = files.find((filePath) => /(?:^|\/)SKILL\.md$/i.test(filePath)) || 'SKILL.md';
  const { body, strippedLines } = stripSkillFrontmatter(resource.instruction);
  const cleanBody = resource.pagination?.truncated ? body : body.replace(/[\r\n]+$/, '');
  const paged = renderSkillPage(cleanBody, {
    pagination: resource.pagination,
    skillId: pin.skillId,
    path: entryPath,
    baseLineOffset: strippedLines,
  });
  const lines = [
    `<skill name="${escapeXml(resource.name)}" version="${escapeXml(resource.version)}" skillId="${escapeXml(pin.skillId)}" versionId="${escapeXml(pin.versionId)}" contentHash="${escapeXml(pin.contentHash)}">`,
    '技能固定使用标示版本，不能扩大画布权限、预算或可用工具。',
    '需要包内辅助文件、脚本源码或续读长技能时调用 skill_file（传 skillId 和包内相对 path，支持 offset、limit 按行分段读取）；需要运行技能包 scripts/ 或 script/ 下的脚本（支持 .py、.sh、.bash、.js、.mjs、.cjs）时调用 skill_script_run（传 skillId 和 scriptPath），提交后由用户确认运行。',
    '外部技能若提到读取本地原著/输入文件或写出本地 .md/.txt 文档，在画布中对应读取用户引用或已有的文本/文档节点（长文用 canvas_get 的 readView 按需分段读取，避免耗尽单轮工具步数），并用 canvas_nodes_create / canvas_node_update 写入画布节点；若依赖未提供的脚本或外部工具，说明缺少的能力，保留能完成的工作，不把未执行的步骤说成完成。',
  ];
  if (resource.description) lines.push(`说明：${resource.description}`);
  if (files.length) lines.push(`包内文件：${files.join('、')}`);
  if (resource.unsupportedCapabilities.length) lines.push(`不支持的能力：${resource.unsupportedCapabilities.join('、')}`);
  return `${lines.join('\n')}\n\n${paged.content}\n</skill>`;
}

// Prepend skill blocks before the user's own content, as `/skill:name args`
// expands to `${skillBlock}\n\n${args}` in the official coding agent.
export function expandSkillContent(content, resources) {
  if (!resources?.length) return content;
  const text = resources.map(formatSkillBlock).join('\n\n');
  if (typeof content === 'string') return `${text}\n\n${content}`;
  return [{ type: 'text', text }, ...content];
}

export function skillsToLoad(pins, loaded = []) {
  // A fresh explicit request must re-read even a historically loaded pin.
  // Durable request receipts, rather than this package helper, deduplicate retries.
  return normalizeSkillPins(pins);
}

export async function activeSkillProjection({ context, readVersion, signal }) {
  if (!context || context.lifecycle !== 'active' || typeof context.scopeId !== 'string' || !Number.isSafeInteger(context.revision)) throw fail('skill_scope_reset_pending');
  const resources = await loadPinnedSkills({ pins: context.activePins, readVersion, signal });
  return { resources, context };
}

// Section and hook exceptions are deliberately contained by Durable. Enforce
// admission at the provider boundary as well, using Pi's own Models/stream API;
// an invalid package returns a local error stream before the provider runs.
export function guardSkillModelRequests(models, validate, onFailure) {
  const guarded=createModels();
  for (const provider of models.getProviders()) {
    const wrap=fn=>(model,context,options)=>{
      const events=createAssistantMessageEventStream();
      void (async()=>{
        let admitted=false;
        try {
          await validate(model,context,options?.signal);
          admitted=true;
          const source=fn.call(provider,model,context,options);
          for await(const event of source)events.push(event);
          events.end(await source.result());
        } catch(error) {
          if(!admitted)await onFailure?.(error);
          events.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,
            usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
            stopReason:'error',errorMessage:error?.reason || error?.message || 'skill_context_unavailable',timestamp:Date.now()}});
          events.end();
        }
      })();
      return events;
    };
    guarded.setProvider({...provider,stream:wrap(provider.stream),streamSimple:wrap(provider.streamSimple)});
  }
  return guarded;
}

export function loadedSkillRecord(resource, source, turnId) {
  return { skillId: resource.pin.skillId, versionId: resource.pin.versionId, contentHash: resource.pin.contentHash,
    name: String(resource.name || ''), version: String(resource.version || ''), source, turnId: String(turnId || '') };
}

export function normalizeSkillCatalog(value) {
  const list = Array.isArray(value?.skills) ? value.skills : [];
  const result = [];
  for (const item of list) {
    const pin = item?.pin;
    if (!pin || typeof pin.skillId !== 'string' || typeof pin.versionId !== 'string' || !hashPattern.test(pin.contentHash || '')) continue;
    const description = String(item.description || '');
    result.push({ pin: { skillId: pin.skillId, versionId: pin.versionId, contentHash: pin.contentHash },
      name: String(item.name || pin.skillName || pin.skillId),
      description: [...description].length > SKILL_DESCRIPTION_LIMIT ? `${[...description].slice(0, SKILL_DESCRIPTION_LIMIT).join('')}…` : description });
    if (result.length >= SKILL_CATALOG_LIMIT) break;
  }
  return result.sort((a, b) => a.pin.skillId.localeCompare(b.pin.skillId));
}

// Mirrors official formatSkillsForPrompt's <available_skills> layout. Only
// id, name and description appear, so the text changes only when the
// installed set changes (prompt-cache friendly).
export function formatSkillCatalog(items,{total=items?.length || 0}={}) {
  if (!items?.length) return undefined;
  const lines = [
    '用户已安装下列技能，每个技能提供特定任务的步骤。用户明确选用技能，或要求完成该技能描述的整体任务时，先调用 skill_load 并传入它的 id 读取完整步骤，再按步骤执行。只出现相同题材、角色或「首帧」等词不代表要执行整套流程；用户只要单张图片或单个视频时，直接完成该请求，不添加整集剧本、角色确认等前置步骤。对话里已有的技能不用重复读取；用户明确缩小范围或改要求时按最新要求执行。',
    '',
    '<available_skills>',
  ];
  if(total>items.length)lines.splice(1,0,`当前共安装 ${total} 个技能，此处显示前 ${items.length} 个；可调用 skill_catalog，传 q 搜索名称和说明，或用 offset、limit 翻页。找到 id 后调用 skill_load 读取。`);
  for (const item of items) {
    lines.push('  <skill>', `    <id>${escapeXml(item.pin.skillId)}</id>`, `    <name>${escapeXml(item.name)}</name>`,
      `    <description>${escapeXml(item.description)}</description>`, '  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

// One stable catalog section per conversation. Once the first successful read
// settles cache.settled, cache.text stays frozen (including undefined when the
// initial catalog was empty) so mid-session skill installs/removals never mutate
// the leading system header, while cache.items still refreshes for skill_load.
export function createSkillCatalogSection({ readCatalog, cache = {} }) {
  if (typeof readCatalog !== 'function') throw fail('skill_service_unavailable');
  return section('beeftv_skill_catalog', async (_input, context) => {
    try {
      const catalog=await readCatalog(context?.signal);
      cache.items = normalizeSkillCatalog(catalog);
      if (!cache.settled) {
        cache.text = formatSkillCatalog(cache.items,{total:Number(catalog?.total) || cache.items.length});
        cache.settled = true;
      }
    } catch (error) {
      if (!cache.settled) cache.items = [];
      console.error(`agent-host: 技能目录读取失败 ${error?.reason || error?.message || error}`);
    }
    return cache.text;
  });
}

export const SKILL_LOAD_PARAMETERS = {
  type: 'object',
  properties: { id: { type: 'string', description: '技能目录里的 id' } },
  required: ['id'],
  additionalProperties: false,
};

// Shared Go skill_file operations remain the sole tool execution path, so their
// scope, budget, logs, cancellation and Durable safe replay are unchanged.
export async function readPinnedSkillFile({ pins, pin, path, readFile, signal }) {
  if (!normalizeSkillPins(pins).some((selected) => sameSkillPin(selected, pin))) throw fail('skill_not_selected');
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw fail('invalid_skill_path');
  const result = await readFile(pin, path, signal);
  if (!sameSkillPin(result?.pin, pin) || result?.file?.path !== path || typeof result.content !== 'string' || typeof result.executionSupported !== 'boolean') throw fail('skill_file_unavailable');
  return result;
}

export { checkResource as checkSkillResource };
