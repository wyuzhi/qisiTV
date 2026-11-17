# Celadon UI 组件层

`web/src/components/ui/` 下的自研组件层。本文是组件目录内的公开速查与维护约定。

## 分层

| 层                   | 目录                       | 内容                                                                                                      |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| base                 | `ui/base/`                 | 原语 + 基础件：`badges/`、`buttons/`、`checkbox/`、`kbd/`、`segmented-control/`、`select/`、`switch/`、`tooltip/` |
| product              | `ui/product/`              | 跨页面模式件：`app-drawer/`、`app-modal/`、`callout/`、`empty-state/`、`settings-row/` 及表单/占位辅助件 |
| aceternity（存量特效） | `ui/aceternity/` 及根级特效件 | 存量动效与视觉装饰件（`fx/` 与 `application/` 命名空间尚在规划中，未建目录前不要按规划路径导入）           |

> 视觉数值以仓库内的主题变量和组件 token 为权威源，组件不得依赖仓库外的私有样式包。

## 目录与导出

- `base/` 与 `product/` 下按"族"建目录（如 `base/badges/`），族内按文件拆变体，族级 `index.ts` 汇总导出（组件 + `XxxVariants` 类型）；**无全局 barrel**。
- 已成族组件一律深路径导入 `@/components/ui/<layer>/<family>`（零散单文件按实际文件路径导入）；组件 `PascalCase`、文件 `kebab-case.tsx`、目录 `kebab-case/`。
- 变体用 cva（`class-variance-authority`）定义并从 `index.ts` 导出类型；`className` 经 `cn` 合并；ref 转发；根元素 `data-slot`。

## 硬性纪律

1. 样式只消费三层 token（`var(--*)` 或经 `@theme` 映射的工具类，如 `bg-surface`、`text-caption`、`text-status-success`）；**禁止裸 `text-[Npx]`/`rounded-[Npx]`/十六进制色值**。字号/行高用注册排版工具类或 token 引用。
2. 明暗自适应由 CSS 变量完成，不读皮肤 ID；持久切换 `aria-pressed` + `data-active`，保留 `:focus-visible`，尊重 `prefers-reduced-motion`。
3. 图标以 lucide 组件引用传入（`icon={Move}`），尺寸/颜色由宿主组件决定，禁止调用方传 icon className 改尺寸。
4. 组件头注释注明：用途、消费 token 组、对标/接管对象（AntD 组件或参考系统组件）、明暗差异要点。

## 进库门槛

新组件必须满足其一：① ≥2 处真实重复（PR 附 grep 证据）；② 隔离明确协议/交互契约。纯透传壳不进库。

## 当前族目录

- `base/kbd/` — Kbd（快捷键提示键帽）
- `base/badges/` — StatusBadge（状态点徽章；NodeTypeBadge 规划中）
- `base/buttons/` — IconButton / ToolButton（IconButton 含 ghost/default/outline/solid/danger 变体；ButtonGroup 规划中）
- `base/segmented-control/` — SegmentedControl（分段单选，thumb 滑动，泛型 + block/size）
- `base/checkbox/` — Checkbox + CheckboxGroup（原生 input + 自绘 glyph，checked/indeterminate/bare）
- `base/select/` — Select（RAC 单选壳，value/options/allowClear；多选/搜索 ComboBox 待建）
- `base/tooltip/` — Tooltip（RAC 浮层，AntD 8 向 placement 映射，title 空不渲染）
- `base/switch/` — Switch（button role=switch + data-state，checkedChildren 文本轨、loading、Form.Item 注入）
- `product/empty-state/` — EmptyState（空态占位）
- `product/callout/` — Callout
- `product/app-modal/` — AppModal（产品弹窗壳，`flush` 去掉 AntD 默认内边距）
- `product/app-drawer/` — AppDrawer（产品侧栏壳）
- `product/settings-row/` — SettingsRow（设置项行布局）
- `product/media-placeholder.tsx`、`product/workspace-form.tsx` — 媒体占位与工作区表单辅助单文件组件
