import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillCatalogSection, expandSkillContent, formatSkillBlock, formatSkillCatalog, loadPinnedSkills, normalizeSkillCatalog,
  normalizeSkillPins, paginateSkillText, readPinnedSkillFile, renderSkillPage, skillsToLoad, stripSkillFrontmatter, activeSkillProjection,
  SKILL_PAGE_MAX_BYTES, SKILL_PAGE_MAX_LINES } from './skill-resource.mjs';

const pin = { skillId: 'user-skill', versionId: 'v1', contentHash: 'a'.repeat(64) };
const resource = { pin, name: '采访切片', version: '1', description: '保留原话', instruction: '先读取 references/interview.md，再按原话整理三个镜头。', files: [{ path: 'references/interview.md' }], unsupportedCapabilities: [] };

test('arbitrary skill sizes and pin counts are accepted without artificial byte or count caps', async () => {
  assert.equal(SKILL_PAGE_MAX_LINES, 2000);
  assert.equal(SKILL_PAGE_MAX_BYTES, 50 * 1024);
  for (const repeats of [10000, 52000, 800000]) {
    const instruction = '镜'.repeat(repeats);
    const loaded = await loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, instruction }) });
    assert.equal(loaded[0].instruction, instruction);
  }
  const sixPins = [1, 2, 3, 4, 5, 6].map((n) => ({ ...pin, skillId: `s${n}` }));
  assert.equal(normalizeSkillPins(sixPins).length, 6);
  const loadedSix = await loadPinnedSkills({ pins: sixPins, readVersion: async (selected) => ({ ...resource, pin: selected, instruction: '字'.repeat(700000) }) });
  assert.equal(loadedSix.length, 6);
});

test('selected skill expands into the user message in the official skill block shape', () => {
  const block = formatSkillBlock(resource);
  assert.match(block, /^<skill name="采访切片" version="1" skillId="user-skill" versionId="v1" contentHash="a{64}">/);
  assert.match(block, /references\/interview.md/);
  assert.match(block, /skill_file/);
  assert.match(block, /不能扩大画布权限、预算或可用工具/);
  assert.match(block, /\n\n先读取 references\/interview.md，再按原话整理三个镜头。\n<\/skill>$/);
  assert.equal(expandSkillContent('只要原话', [resource]), `${block}\n\n只要原话`);
  const parts = expandSkillContent([{ type: 'text', text: '用户原文' }, { type: 'image', data: 'x', mimeType: 'image/png' }], [resource]);
  assert.equal(parts.length, 3); assert.equal(parts[0].text, block); assert.equal(parts[1].text, '用户原文');
  assert.equal(expandSkillContent('原文', []), '原文');
  assert.match(formatSkillBlock({ ...resource, name: 'a"<b>' }), /name="a&quot;&lt;b&gt;"/);
});

test('fresh explicit selection reads even a historically loaded exact pin', () => {
  const loaded = [{ ...pin, name: '采访切片', source: 'selected' }];
  assert.deepEqual(skillsToLoad([pin], loaded), [pin]);
  assert.deepEqual(skillsToLoad([{ ...pin, versionId: 'v2' }], loaded), [{ ...pin, versionId: 'v2' }]);
  assert.throws(() => skillsToLoad([{ ...pin, contentHash: 'fixture-hash' }], loaded), /invalid_skill_selection/);
});

test('active projection loads active pins cleanly without homemade token window rejections or dead text formatting', async () => {
  const context = { scopeId: 'scope', revision: 2, lifecycle: 'active', activePins: [pin] };
  const mediumBody = '改编镜头规则。\n'.repeat(1200);
  const projected = await activeSkillProjection({
    context,
    readVersion: async () => ({ ...resource, instruction: `---\nname: 外部长技能\ndescription: 长正文\n---\n${mediumBody}` }),
  });
  assert.equal(projected.text, undefined);
  assert.equal(projected.resources.length, 1);
  assert(formatSkillBlock(projected.resources[0]).includes('改编镜头规则。'));
  assert(!formatSkillBlock(projected.resources[0]).includes('name: 外部长技能'));

  const hugeBody = Array.from({ length: 3200 }, (_, idx) => `第${idx + 1}条分镜规则`).join('\n');
  const hugeProjected = await activeSkillProjection({
    context,
    readVersion: async () => ({ ...resource, instruction: `---\nname: 超长技能\n---\n${hugeBody}` }),
  });
  assert.match(formatSkillBlock(hugeProjected.resources[0]), /offset=2004[\s\S]*skillId="user-skill", path="SKILL\.md"/);
  await assert.rejects(activeSkillProjection({ context: { ...context, lifecycle: 'reset_pending' }, readVersion: async () => resource }), /skill_scope_reset_pending/);
});

test('stripSkillFrontmatter, paginateSkillText, and renderSkillPage use unified 2000-line / 50KB paging with UTF-8 rune safety', () => {
  const raw = '---\nname: 小说改编\ndescription: 测试\n---\n\n第一行正文\n第二行正文\n第三行正文';
  const stripped = stripSkillFrontmatter(raw);
  assert.equal(stripped.strippedLines, 5);
  assert.equal(stripped.body, '第一行正文\n第二行正文\n第三行正文');

  const page1 = paginateSkillText(stripped.body, { maxLines: 2, skillId: 'novel', path: 'SKILL.md', baseLineOffset: stripped.strippedLines });
  assert.equal(page1.truncated, true);
  assert.equal(page1.startLine, 6);
  assert.equal(page1.endLine, 7);
  assert.equal(page1.totalLines, 8);
  assert.match(page1.content, /offset=8[\s\S]*skillId="novel", path="SKILL\.md"/);

  const page2 = paginateSkillText(raw, { offset: 8, limit: 5, skillId: 'novel', path: 'SKILL.md' });
  assert.equal(page2.truncated, false);
  assert.match(page2.content, /^第三行正文\n\n\[当前显示第 8-8 行（共 8 行，已到文件末尾）。\]$/);

  // Go streamed page 1 with physical pagination metadata + frontmatter stripped on host:
  const goStreamedInstruction = `---\nname: 超长技能\ndescription: 流式分页\n---\n\n${Array.from({ length: 1995 }, (_, i) => `规则第${i + 1}行`).join('\n')}`;
  const streamedBlock = formatSkillBlock({
    ...resource,
    instruction: goStreamedInstruction,
    pagination: { startLine: 1, endLine: 2000, totalLines: 3500, truncated: true },
  });
  assert.match(streamedBlock, /当前显示第 6-2000 行（共 3500 行）[\s\S]*offset=2001/);
  assert.match(streamedBlock, /<\/skill>$/);

  // Fallback JS pagination when pagination metadata is absent:
  const hugeInstruction = `---\nname: 超长技能\n---\n${Array.from({ length: 2400 }, (_, i) => `规则第${i + 1}行`).join('\n')}`;
  const block = formatSkillBlock({ ...resource, instruction: hugeInstruction });
  assert.match(block, /offset=2004/);
  assert.match(block, /<\/skill>$/);

  // Single oversized line (> maxBytes) slices cleanly on UTF-8 rune boundary without replacement chars:
  const singleLongLine = `${'🎬甲'.repeat(30)}\n尾行确认`;
  const longP1 = paginateSkillText(singleLongLine, { maxBytes: 50, skillId: 'novel', path: 'references/one-line.md' });
  assert.equal(longP1.truncated, true);
  assert.equal(longP1.firstLineExceedsLimit, true);
  assert.equal(longP1.startLine, 1);
  assert.equal(longP1.endLine, 1);
  assert.equal(longP1.totalLines, 2);
  assert(!longP1.content.includes('\uFFFD'));
  assert.match(longP1.content, /第 1 行共 210 字节，超出单页上限，当前仅展示前 49 字节（同行超出部分不再展开；文件共 2 行）。如需继续阅读后续行，请传 offset=2 调用 skill_file/);

  const renderedNext = renderSkillPage('尾行确认', {
    pagination: { startLine: 2, endLine: 2, totalLines: 2, truncated: false },
    offset: 2,
    skillId: 'novel',
    path: 'references/one-line.md',
  });
  assert.match(renderedNext.content, /^尾行确认\n\n\[当前显示第 2-2 行（共 2 行，已到文件末尾）。\]$/);
});

test('update does not replace a pinned version and uninstall cannot silently use cached instructions', async () => {
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => ({ ...resource, pin: { ...pin, versionId: 'v2' } }) }), /skill_version_unavailable/);
  await assert.rejects(loadPinnedSkills({ pins: [pin], readVersion: async () => { throw Error('skill_uninstalled'); } }), /skill_uninstalled/);
});

test('auxiliary files require selected version and package relative path; supported scripts expose executionSupported', async () => {
  const readFile = async (selected, path) => ({
    pin: selected,
    file: { path },
    content: path.startsWith('scripts/') ? 'console.log("ok")' : '原话来自采访素材',
    executionSupported: path.startsWith('scripts/'),
  });
  const result = await readPinnedSkillFile({ pins: [pin], pin, path: 'references/interview.md', readFile });
  assert.equal(result.content, '原话来自采访素材');
  assert.equal(result.executionSupported, false);
  const scriptResult = await readPinnedSkillFile({ pins: [pin], pin, path: 'scripts/run.js', readFile });
  assert.equal(scriptResult.executionSupported, true);
  for (const path of ['../secrets', '/etc/passwd', 'https://example.com', 'scripts\\run.js']) {
    await assert.rejects(readPinnedSkillFile({ pins: [pin], pin, path, readFile }), /invalid_skill_path/);
  }
  await assert.rejects(readPinnedSkillFile({ pins: [], pin, path: 'SKILL.md', readFile }), /skill_not_selected/);
});

test('no selection performs no package discovery; skill block advertises skill_script_run and unsupported capabilities', async () => {
  let called = false;
  assert.deepEqual(await loadPinnedSkills({ pins: [], readVersion: async () => { called = true; } }), []);
  assert.equal(called, false);
  const supportedBlock = formatSkillBlock(resource);
  assert.match(supportedBlock, /skill_script_run/);
  const block = formatSkillBlock({ ...resource, unsupportedCapabilities: ['unsupported_script_interpreter'] });
  assert.match(block, /unsupported_script_interpreter/);
  assert.match(block, /不把未执行的步骤说成完成/);
});

test('catalog mirrors available_skills, is bounded, and stays byte-stable across requests and failures', async () => {
  const items = Array.from({ length: 60 }, (_, index) => ({ pin: { skillId: `skill-${String(index).padStart(2, '0')}`, versionId: 'v1', contentHash: 'c'.repeat(64), skillName: `技能${index}` },
    name: `技能${index}`, description: '说明'.repeat(200) }));
  const normalized = normalizeSkillCatalog({ skills: [...items, { pin: { skillId: 'bad', versionId: 'v', contentHash: 'nope' } }] });
  assert.equal(normalized.length, 50);
  assert.equal([...normalized[0].description].length, 301);
  const text = formatSkillCatalog(normalized);
  assert.match(text, /<available_skills>\n {2}<skill>\n {4}<id>skill-00<\/id>\n {4}<name>技能0<\/name>/);
  assert.match(text, /skill_load/);
  assert.doesNotMatch(text, /contentHash|cccc/);
  assert.equal(formatSkillCatalog([]), undefined);
  let fail = false; let calls = 0;
  const cache = {};
  const section = createSkillCatalogSection({ cache, readCatalog: async () => { calls++; if (fail) throw new Error('offline'); return { skills: items.slice(0, 2) }; } });
  assert.equal(section.key, 'beeftv_skill_catalog');
  const first = await section.render({}, {});
  assert.equal(await section.render({}, {}), first);
  fail = true;
  assert.equal(await section.render({}, {}), first, 'a failed refresh must not drop the section');
  assert.equal(calls, 3);
  assert.equal(cache.items.length, 2);

  // An initially empty catalog stays frozen as undefined even if skills are installed later in the session,
  // while cache.items still updates for skill_load.
  let emptyFirst = true;
  const emptyCache = {};
  const emptySection = createSkillCatalogSection({
    cache: emptyCache,
    readCatalog: async () => {
      if (emptyFirst) {
        emptyFirst = false;
        return { skills: [] };
      }
      return { skills: items.slice(0, 1) };
    },
  });
  assert.equal(await emptySection.render({}, {}), undefined);
  assert.equal(await emptySection.render({}, {}), undefined);
  assert.equal(emptyCache.items.length, 1);
});
