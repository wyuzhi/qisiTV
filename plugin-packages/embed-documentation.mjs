import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const contractStart = "<!-- QISITV_PLUGIN_MANIFEST_START -->";
const contractEnd = "<!-- QISITV_PLUGIN_MANIFEST_END -->";
const recursiveDocumentationPlaceholder =
  "<当前插件的完整 documentation，由 README.md 与 docs/interface.md 拼接而成；为避免 JSON 递归，此处不重复展开正文。>";

function normalizeNewlines(document) {
  return document.replace(/\r\n?/g, "\n");
}

function withoutGeneratedContract(document) {
  // A namespace migration or upstream merge can leave more than one generated
  // contract. Strip every generated block before adding the current manifest.
  for (const [startMarker, endMarker] of [[contractStart, contractEnd], ["<!-- BEEFTV_PLUGIN_MANIFEST_START -->", "<!-- BEEFTV_PLUGIN_MANIFEST_END -->"]]) {
    let start;
    while ((start = document.indexOf(startMarker)) >= 0) {
      const end = document.indexOf(endMarker, start);
      if (end < 0) {
        throw new Error("docs/interface.md contains an unterminated generated manifest contract");
      }
      document = `${document.slice(0, start)}${document.slice(end + endMarker.length)}`;
    }
  }
  return document.trimEnd();
}

function renderContract(manifest) {
  const contract = JSON.parse(JSON.stringify(manifest));
  contract.documentation = recursiveDocumentationPlaceholder;
  return `${contractStart}
## Manifest 完整接口定义

以下 JSON 与插件包内实际 \`manifest.json\` 逐字段一致，覆盖插件身份、权限、配置、鉴权、参数、校验、创建、Agent、查询、取消、结果下载、响应和 Agent 响应映射。\`documentation\` 字段的值就是当前完整文档；为避免文档在自身内部无限递归，JSON 中仅用等义占位文本表示正文。

\`\`\`json
${JSON.stringify(contract, null, 2)}
\`\`\`
${contractEnd}`;
}

const entries = await readdir(root, { withFileTypes: true });
const requestedPackageIDs = new Set(process.argv.slice(2).map((value) => value.trim()).filter(Boolean));
const packageDirectories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => requestedPackageIDs.size === 0 || requestedPackageIDs.has(name))
  .sort();

let updated = 0;
for (const packageID of packageDirectories) {
  const packageRoot = join(root, packageID);
  let manifestSource;
  try {
    manifestSource = normalizeNewlines(await readFile(join(packageRoot, "manifest.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }

  const manifest = JSON.parse(manifestSource);
  const readmePath = join(packageRoot, "README.md");
  const readme = normalizeNewlines(await readFile(readmePath, "utf8")).trim();
  const interfacePath = join(packageRoot, "docs", "interface.md");
  const interfaceSource = normalizeNewlines(await readFile(interfacePath, "utf8"));
  const interfaceDocument = `${withoutGeneratedContract(interfaceSource)}\n\n${renderContract(manifest)}\n`;
  manifest.documentation = `${readme}\n\n---\n\n${interfaceDocument.trim()}\n`;

  await writeFile(readmePath, `${readme}\n`);
  await writeFile(interfacePath, interfaceDocument);
  await writeFile(join(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  updated += 1;
}

if (updated === 0) {
  throw new Error("no protocol plugin manifests were found");
}

console.log(`embedded complete documentation into ${updated} protocol packages`);
