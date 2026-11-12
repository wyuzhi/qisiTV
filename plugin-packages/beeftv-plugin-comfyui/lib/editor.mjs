// 把 ComfyUI 普通「保存」出来的工作流（界面格式）转成 /prompt 能执行的 API 格式，
// 并读出作者在 App Mode 里挑好的输入和输出。
//
// 改写自 Node Banana 的 src/lib/comfy/editor.ts（MIT，Copyright (c) 2026 William Falloon），
// 去掉了 Blueprint 导入；许可证原文见 THIRD_PARTY_NOTICES.md。
//
// 界面格式按位置保存控件值（widgets_values），不带名字，所以要拿 ComfyUI 的
// /object_info 节点目录，按每个节点声明输入的顺序把值对回名字。子图会被展开，
// 里面的节点 ID 写成 `实例:内部`，和 ComfyUI 自己导出 API 格式时一致。

// 只在界面上存在、执行时不需要的节点。PrimitiveNode 的值由前端直接写进它连着的控件。
const COSMETIC_TYPES = new Set(["Note", "MarkdownNote", "Reroute", "PrimitiveNode"]);

const SEED_CONTROL_VALUES = new Set(["fixed", "increment", "decrement", "randomize"]);

export class ComfyConversionError extends Error {
  constructor(message, unknownNodeType) {
    super(message);
    this.name = "ComfyConversionError";
    if (unknownNodeType) this.unknownNodeType = unknownNodeType;
  }
}

/** 界面格式带 nodes 数组；API 格式是以节点 ID 为键的对象。 */
export function isEditorFormat(raw) {
  return raw !== null && typeof raw === "object" && Array.isArray(raw.nodes);
}

function specOptions(spec) {
  return spec[1] && typeof spec[1] === "object" ? spec[1] : {};
}

// 保存时漏掉的必填控件用 ComfyUI 的默认值补上；前端总会发一个值，引擎也按有值校验。
function widgetDefault(spec) {
  const type = spec[0];
  const opts = specOptions(spec);
  if ("default" in opts) return opts.default;
  if (Array.isArray(type)) return type[0];
  if (type === "COMBO") {
    const options = Array.isArray(opts.options) ? opts.options : [];
    return options[0];
  }
  // 动态下拉的值是选中项的 key，目录里不声明 default，前端默认选第一项。
  if (typeof type === "string" && type.startsWith("COMFY_DYNAMICCOMBO_")) {
    const options = Array.isArray(opts.options) ? opts.options : [];
    const first = options[0];
    return first !== null && typeof first === "object" ? first.key : first;
  }
  if (type === "INT" || type === "FLOAT") return 0;
  if (type === "STRING") return "";
  if (type === "BOOLEAN") return false;
  return undefined;
}

function specEntries(input) {
  const all = { ...(input?.required ?? {}), ...(input?.optional ?? {}) };
  return Object.entries(all)
    .filter((entry) => Array.isArray(entry[1]))
    .map(([name, spec]) => ({ name, spec }));
}

// 按节点声明顺序把 widgets_values 对到输入名上，和前端创建控件的顺序一致。
// 动态下拉（COMFY_DYNAMICCOMBO_*）的子控件紧跟在它后面，名字写成 `model.aspect_ratio`；
// COMFY_AUTOGROW_* / COMFY_MATCHTYPE_* 只生成连线口，不占控件值。
// 种子控件后面跟着一个「生成后怎么变」的值；值是 fixed 时记进 fixedSeeds，提交时不换种子。
function assignWidgetValues(inputs, entries, values, state, connectionNames, fixedSeeds, prefix = "") {
  for (const { name, spec } of entries) {
    const type = spec[0];
    const opts = specOptions(spec);

    if (typeof type === "string" && type.startsWith("COMFY_DYNAMICCOMBO_")) {
      if (state.i >= values.length) return;
      const selected = values[state.i];
      state.i += 1;
      inputs[`${prefix}${name}`] = selected;
      const options = Array.isArray(opts.options) ? opts.options : [];
      const option = options.find((o) => o !== null && typeof o === "object" && o.key === selected);
      if (option?.inputs) {
        assignWidgetValues(inputs, specEntries(option.inputs), values, state, connectionNames, fixedSeeds, `${prefix}${name}.`);
      }
      continue;
    }

    if (typeof type === "string" && (type.startsWith("COMFY_AUTOGROW_") || type.startsWith("COMFY_MATCHTYPE_"))) {
      continue;
    }

    // 连线口不占控件值：节点把它列成真正的输入口，或者目录要求只能连线。
    const fullName = `${prefix}${name}`;
    if (connectionNames.has(fullName) || opts.forceInput === true) continue;
    if (state.i >= values.length) return;

    // 数组值会被当成连线，照前端的做法包一层。
    inputs[fullName] = Array.isArray(values[state.i]) ? { __value__: values[state.i] } : values[state.i];
    state.i += 1;

    const seedLike = Boolean(opts.control_after_generate) || name === "seed" || name === "noise_seed";
    if (seedLike && typeof values[state.i] === "string" && SEED_CONTROL_VALUES.has(values[state.i])) {
      if (values[state.i] === "fixed") fixedSeeds.add(fullName);
      state.i += 1;
    }
    // 上传控件后面跟着一个占位值。
    if (opts.image_upload === true && values[state.i] === "image") state.i += 1;
  }
}

// CustomCombo 的选项是动态的 option1..optionN，目录只声明了前几个，直接按位置读。
function assignCustomComboValues(inputs, values) {
  if (values.length > 0) inputs.choice = values[0];
  if (values.length > 1) inputs.index = values[1];
  let n = 1;
  for (let k = 2; k < values.length; k += 1) {
    const v = values[k];
    if (typeof v === "string" && v.trim() === "") continue;
    inputs[`option${n}`] = v;
    n += 1;
  }
}

function normalizeLinks(links) {
  const map = new Map();
  for (const link of links ?? []) {
    if (Array.isArray(link)) {
      map.set(link[0], { origin: String(link[1]), originSlot: link[2] });
    } else if (link && typeof link === "object") {
      map.set(link.id, { origin: String(link.origin_id), originSlot: link.origin_slot });
    }
  }
  return map;
}

function linkTargets(links) {
  const map = new Map();
  for (const link of links ?? []) {
    if (Array.isArray(link)) {
      map.set(link[0], { target: String(link[3]), slot: link[4] });
    } else if (link && typeof link === "object") {
      map.set(link.id, { target: String(link.target_id), slot: link.target_slot });
    }
  }
  return map;
}

// 一层图：根工作流，或者某个子图实例里面的图。
function buildScope(nodes, links, defs, prefix, parent, instance, def, depth) {
  if (depth > 10) throw new ComfyConversionError("子图嵌套太深（或互相引用），没法转换");
  const scope = {
    prefix,
    nodes: new Map(nodes.map((n) => [String(n.id), n])),
    links: normalizeLinks(links),
    boundaryOwner: new Map(),
    boundaryWidgetValue: new Map(),
    instance,
    def,
    parent,
    children: new Map(),
  };
  for (const [slot, input] of (def?.inputs ?? []).entries()) {
    for (const linkId of input.linkIds ?? []) scope.boundaryOwner.set(linkId, slot);
  }
  // 子图实例上提出来的控件值按子图定义里「接到控件上的边界口」排序，
  // 不按实例的 inputs 排：实例只列出作者连过或改过的口，两边长度和顺序常常对不上。
  if (instance && Array.isArray(instance.widgets_values)) {
    const values = instance.widgets_values;
    widgetBackedSlots(def).forEach((name, index) => {
      if (index < values.length) scope.boundaryWidgetValue.set(name, values[index]);
    });
  }
  for (const node of nodes) {
    const childDef = defs.get(String(node.type));
    if (childDef) {
      scope.children.set(
        String(node.id),
        buildScope(childDef.nodes, childDef.links, defs, `${prefix}${node.id}:`, scope, node, childDef, depth + 1),
      );
    }
  }
  return scope;
}

function widgetBackedSlots(def) {
  const nodes = new Map((def?.nodes ?? []).map((n) => [String(n.id), n]));
  const targets = linkTargets(def?.links);
  const names = [];
  for (const slot of def?.inputs ?? []) {
    if (!slot.name) continue;
    const backed = (slot.linkIds ?? []).some((linkId) => {
      const target = targets.get(linkId);
      return target ? Boolean(nodes.get(target.target)?.inputs?.[target.slot]?.widget) : false;
    });
    if (backed) names.push(slot.name);
  }
  return names;
}

function resolveLinkId(scope, linkId, depth) {
  if (depth > 100) return null;
  // 从子图边界口出来的连线到上一层去找来源；实例只列出用过的口，按名字对。
  const boundarySlot = scope.boundaryOwner.get(linkId);
  if (boundarySlot !== undefined) {
    const boundaryName = scope.def?.inputs?.[boundarySlot]?.name;
    const outer = boundaryName
      ? (scope.instance?.inputs ?? []).find((i) => i.name === boundaryName)
      : scope.instance?.inputs?.[boundarySlot];
    if (outer?.link != null && scope.parent) return resolveLinkId(scope.parent, outer.link, depth + 1);
    const value = boundaryName ? scope.boundaryWidgetValue.get(boundaryName) : undefined;
    if (value !== undefined && value !== null) return { kind: "value", value };
    return null;
  }
  const link = scope.links.get(linkId);
  if (!link) return null;
  return resolveOrigin(scope, link.origin, link.originSlot, depth);
}

function resolveOrigin(scope, originId, slot, depth) {
  if (depth > 100) return null;
  const child = scope.children.get(originId);
  if (child) {
    const innerLinkId = child.def?.outputs?.[slot]?.linkIds?.[0];
    if (innerLinkId == null) return null;
    return resolveLinkId(child, innerLinkId, depth + 1);
  }
  const node = scope.nodes.get(originId);
  if (!node) return null;
  if (node.type === "Reroute") {
    const upstream = node.inputs?.[0]?.link;
    return upstream == null ? null : resolveLinkId(scope, upstream, depth + 1);
  }
  if (node.type === "PrimitiveNode") {
    const value = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
    return value === undefined ? null : { kind: "value", value };
  }
  if (node.mode === 4) {
    // 旁路节点：照前端的规则把输入直接接到输出。
    const outType = node.outputs?.[slot]?.type;
    const inputs = node.inputs ?? [];
    const compatible = (a, b) => !a || !b || a === b || a === "*" || b === "*";
    let match;
    if (outType === "*" || outType === "" || outType === undefined) {
      match = inputs[slot] ?? inputs[0];
    } else if (inputs[slot] && compatible(inputs[slot].type, outType)) {
      match = inputs[slot];
    } else {
      match = inputs.find((i) => i.type === outType) ?? inputs.find((i) => compatible(i.type, outType));
    }
    return match?.link != null ? resolveLinkId(scope, match.link, depth + 1) : null;
  }
  if (node.mode === 2) return null;
  return { kind: "link", key: `${scope.prefix}${originId}`, slot };
}

/**
 * 把界面格式的工作流转成 API 格式，展开子图。
 * 返回 { graph, fixedSeeds }：fixedSeeds 是作者设成「固定」的种子，形如 `节点ID.输入名`。
 */
export function convertEditorGraph(file, objectInfo) {
  const defs = new Map();
  for (const def of file.definitions?.subgraphs ?? []) defs.set(String(def.id), def);

  const root = buildScope(file.nodes, file.links, defs, "", null, null, null, 0);
  const graph = {};
  const fixedSeeds = new Set();

  const emitScope = (scope) => {
    for (const node of scope.nodes.values()) {
      const id = String(node.id);
      if (node.mode === 2 || node.mode === 4) continue;
      const child = scope.children.get(id);
      if (child) {
        emitScope(child);
        continue;
      }
      if (COSMETIC_TYPES.has(node.type)) continue;

      const key = `${scope.prefix}${id}`;
      const api = { class_type: node.type, inputs: {}, ...(node.title ? { _meta: { title: node.title } } : {}) };
      // 转成输入口的控件带 widget 标记、仍然有值，不算连线口。
      const connectionNames = new Set((node.inputs ?? []).filter((inp) => !inp.widget).map((inp) => inp.name));

      const values = node.widgets_values;
      if (node.type === "CustomCombo" && Array.isArray(values)) {
        assignCustomComboValues(api.inputs, values);
      } else if (values && !Array.isArray(values) && typeof values === "object") {
        // 有的节点包（比如 VHS）已经按名字保存控件值。
        for (const [name, value] of Object.entries(values)) {
          if (value === null) continue;
          api.inputs[name] = Array.isArray(value) ? { __value__: value } : value;
        }
      } else if (Array.isArray(values) && values.length > 0) {
        if (!objectInfo[node.type]) {
          throw new ComfyConversionError(`这台 ComfyUI 没有节点「${node.type}」，请先装好它所在的节点包`, node.type);
        }
        const seeds = new Set();
        assignWidgetValues(api.inputs, specEntries(objectInfo[node.type]?.input), values, { i: 0 }, connectionNames, seeds);
        for (const name of seeds) fixedSeeds.add(`${key}.${name}`);
      }

      // 连线覆盖控件上的占位值。
      for (const input of node.inputs ?? []) {
        if (input.link == null) continue;
        const resolved = resolveLinkId(scope, input.link, 0);
        if (resolved?.kind === "link") api.inputs[input.name] = [resolved.key, resolved.slot];
        else if (resolved?.kind === "value") api.inputs[input.name] = resolved.value;
      }

      for (const [name, spec] of Object.entries(objectInfo[node.type]?.input?.required ?? {})) {
        if (!Array.isArray(spec) || name in api.inputs || connectionNames.has(name)) continue;
        if (specOptions(spec).forceInput === true) continue;
        const fallback = widgetDefault(spec);
        if (fallback !== undefined) api.inputs[name] = fallback;
      }

      graph[key] = api;
    }
  };
  emitScope(root);

  // 和前端一样，去掉指向已排除节点（静音、旁路、只在界面上存在）的连线。
  for (const node of Object.values(graph)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && typeof value[0] === "string" && !graph[value[0]]) delete node.inputs[name];
    }
  }

  if (Object.keys(graph).length === 0) throw new ComfyConversionError("这个工作流里没有能执行的节点");
  return { graph, fixedSeeds };
}

/** 界面格式里需要查节点目录的节点类型，用来一次说清缺哪些节点包。 */
export function editorNodeTypes(file) {
  const types = new Set();
  const defs = new Set((file.definitions?.subgraphs ?? []).map((d) => String(d.id)));
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.mode === 2 || node.mode === 4) continue;
      const type = String(node.type);
      if (defs.has(type) || COSMETIC_TYPES.has(type)) continue;
      types.add(type);
    }
  };
  walk(file.nodes);
  for (const def of file.definitions?.subgraphs ?? []) walk(def.nodes);
  return [...types].sort();
}

/* App Mode */

function outputEntryId(entry) {
  if (typeof entry === "string" || typeof entry === "number") return String(entry);
  if (entry && typeof entry === "object") {
    if (entry.id !== undefined) return String(entry.id);
    if (entry.nodeId !== undefined) return String(entry.nodeId);
  }
  return null;
}

/**
 * linearData.inputs 每一项的第一个元素是节点 ID，前端改过两次写法，三种都还在用：
 * 纯节点 ID（"3"）、旧的 "节点:子节点"、新的 "图ID:节点ID:控件名"（后两段做过 URL 转义）。
 */
export function parseAppModeInputId(raw) {
  if (typeof raw === "number") return { nodeId: String(raw) };
  if (typeof raw !== "string" || raw === "") return null;
  if (!raw.includes(":")) return { nodeId: raw };
  const segments = raw.split(":");
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (segments.length >= 3) return { nodeId: decode(segments[1]), widget: decode(segments[2]) };
  return { nodeId: segments.map(decode).join(":") };
}

const BOUNDARY_SLOT_ID = "-1";
const MAX_PROXY_DEPTH = 6;

function boundarySlotBindings(def, slotName) {
  const slot = (def?.inputs ?? []).find((s) => s.name === slotName);
  if (!slot) return [];
  const targets = linkTargets(def?.links);
  const nodes = new Map((def?.nodes ?? []).map((n) => [String(n.id), n]));
  const bindings = [];
  const seen = new Set();
  for (const linkId of slot.linkIds ?? []) {
    const target = targets.get(linkId);
    if (!target) continue;
    const widget = nodes.get(target.target)?.inputs?.[target.slot]?.name;
    if (!widget) continue;
    const key = `${target.target} ${widget}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ innerId: target.target, widget });
  }
  return bindings;
}

function consumersOf(def, nodeId) {
  const nodes = new Map((def?.nodes ?? []).map((n) => [String(n.id), n]));
  const bindings = [];
  const seen = new Set();
  for (const link of def?.links ?? []) {
    const origin = Array.isArray(link) ? String(link[1]) : String(link.origin_id);
    if (origin !== nodeId) continue;
    const targetId = Array.isArray(link) ? String(link[3]) : String(link.target_id);
    const slot = Array.isArray(link) ? link[4] : link.target_slot;
    const widget = nodes.get(targetId)?.inputs?.[slot]?.name;
    if (!widget) continue;
    const key = `${targetId} ${widget}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ innerId: targetId, widget });
  }
  return bindings;
}

// 子图实例上提出来的控件，落到展开后真正的节点上；一个边界口可能同时接好几个节点。
function resolveProxied(file, def, prefix, innerId, widget, depth = 0) {
  if (!def || depth > MAX_PROXY_DEPTH) return [];
  if (innerId === BOUNDARY_SLOT_ID) {
    return boundarySlotBindings(def, widget).flatMap((b) => resolveProxied(file, def, prefix, b.innerId, b.widget, depth + 1));
  }
  const node = (def.nodes ?? []).find((n) => String(n.id) === innerId);
  if (!node) return [];
  if (node.type === "PrimitiveNode") {
    return consumersOf(def, innerId).flatMap((b) => resolveProxied(file, def, prefix, b.innerId, b.widget, depth + 1));
  }
  const nested = (file.definitions?.subgraphs ?? []).find((d) => String(d.id) === String(node.type));
  if (nested) {
    return boundarySlotBindings(nested, widget).flatMap((b) => resolveProxied(file, nested, `${prefix}:${innerId}`, b.innerId, b.widget, depth + 1));
  }
  return [{ nodeId: `${prefix}:${innerId}`, widget }];
}

function promotedBindings(file, instanceNodeId, widget) {
  const instance = (file.nodes ?? []).find((n) => String(n.id) === instanceNodeId);
  if (!instance) return [];
  const def = (file.definitions?.subgraphs ?? []).find((d) => String(d.id) === String(instance.type));
  if (!def) return [];
  const [primary, ...rest] = resolveProxied(file, def, instanceNodeId, BOUNDARY_SLOT_ID, widget);
  if (!primary) return [];
  return [{ nodeId: primary.nodeId, widget: primary.widget, ...(rest.length > 0 ? { alsoBind: rest } : {}) }];
}

/**
 * 读出作者在 App Mode 里挑的输入和输出。没有明确关掉（linearMode === false）就当开着：
 * 前端只写 linearData、不写 linearMode。引用了已删除、静音或旁路节点的项会被丢掉。
 * 返回 { inputs: [{ nodeId, widget, alsoBind? }], outputNodeIds }，什么都没挑时返回 null。
 */
export function extractAppMode(file, knownNodeIds) {
  const data = file.extra?.linearData ?? file.extra?.appMode;
  if (file.extra?.linearMode === false || !data) return null;

  const ids = knownNodeIds ? new Set(knownNodeIds) : new Set(file.nodes.map((n) => String(n.id)));
  // 新写法只带子图里的内部 ID，展开后是 `实例:内部`；只有唯一匹配时才按后缀认。
  const resolveId = (candidate) => {
    if (ids.has(candidate)) return candidate;
    const suffix = `:${candidate}`;
    const matches = [...ids].filter((id) => id.endsWith(suffix));
    return matches.length === 1 ? matches[0] : undefined;
  };

  const inputs = [];
  for (const entry of data.inputs ?? []) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const parsed = parseAppModeInputId(entry[0]);
    if (!parsed) continue;
    const widget = String(entry[1] ?? parsed.widget ?? "");
    if (!widget) continue;
    const nodeId = resolveId(parsed.nodeId);
    if (!nodeId) {
      // ID 指向子图实例时，控件名就是边界口名，落到它在子图里接的节点上。
      for (const binding of promotedBindings(file, parsed.nodeId, widget)) {
        if (inputs.some((i) => i.nodeId === binding.nodeId && i.widget === binding.widget)) continue;
        inputs.push(binding);
      }
      continue;
    }
    if (inputs.some((i) => i.nodeId === nodeId && i.widget === widget)) continue;
    inputs.push({ nodeId, widget });
  }

  const outputNodeIds = [];
  for (const entry of data.outputs ?? []) {
    const id = outputEntryId(entry);
    if (id === null) continue;
    const nodeId = resolveId(id);
    if (nodeId && !outputNodeIds.includes(nodeId)) outputNodeIds.push(nodeId);
  }

  if (inputs.length === 0 && outputNodeIds.length === 0) return null;
  return { inputs, outputNodeIds };
}
