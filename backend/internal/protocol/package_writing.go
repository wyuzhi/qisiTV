package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// npm 插件的 beeftv 清单只认一种写法。别名和放错位置的字段以前会被悄悄忽略，
// 开发者照着写却不生效；安装和更新时逐项指出该怎么改。已经装好的插件不在启动时
// 重新检查，旧写法照旧加载，更新到新版本时才要求改。
var (
	packageManifestKeys = map[string]string{
		"name": "", "client": "", "surfaces": "", "permissions": "", "configuration": "", "contributes": "",
		"id":            "插件 ID 取自 package.json 的 name，删掉这一项",
		"version":       "版本取自 package.json 的 version，删掉这一项",
		"description":   "说明写在 package.json 的 description",
		"author":        "作者写在 package.json 的 author",
		"displayName":   "显示名写在 beeftv.name",
		"apiVersion":    "不用写，npm 插件总按最新的清单规则读取",
		"schemaVersion": "不用写，删掉这一项",
		"trusted":       "不用写，只有 BeefTV 自带的插件算内置",
		"renderer":      "写在 beeftv.contributes.canvasNodes[].renderer",
		"canvasNodes":   "写在 beeftv.contributes.canvasNodes",
		"providers":     "写在 beeftv.contributes.providers",
		"workflows":     "写在 beeftv.contributes.workflows",
	}
	packageContributionKeys = map[string]string{
		"providers": "", "workflows": "", "canvasNodes": "",
		"skills":      "技能写在 package.json 的 pi.skills",
		"extensions":  "助手扩展写在 package.json 的 pi.extensions",
		"slots":       "界面挂点在 client 代码里用 host.contribute 注册",
		"editorSlots": "界面挂点在 client 代码里用 host.contribute 注册",
	}
	packageCanvasNodeKeys = map[string]string{
		"id": "", "label": "", "defaultTitle": "", "defaultSize": "", "schema": "", "renderer": "", "fields": "",
		"description": "", "acceptsInputKind": "", "maxInputCount": "", "showOutputConnection": "",
		"type":          "节点类型就是 id，删掉 type",
		"title":         "用 label（添加菜单里的名字）和 defaultTitle（新节点的标题）",
		"defaultWidth":  "用 defaultSize: { width, height }",
		"defaultHeight": "用 defaultSize: { width, height }",
	}
	packageFieldKeys = map[string]string{
		"name": "", "type": "", "label": "", "required": "", "secret": "", "default": "", "description": "", "values": "",
		"key":          "字段名用 name",
		"defaultValue": "默认值用 default",
		"options":      "下拉选项用 values（字符串数组）",
	}
)

// CheckPackageManifestWriting 检查 npm 插件包 package.json 里 beeftv 的写法，一次列出全部问题。
func CheckPackageManifestWriting(root string) error {
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return fmt.Errorf("read package.json: %w", err)
	}
	var pkg struct {
		BeefTV json.RawMessage `json:"beeftv"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		return fmt.Errorf("decode package.json: %w", err)
	}
	var manifest map[string]json.RawMessage
	if len(pkg.BeefTV) == 0 || string(pkg.BeefTV) == "null" || json.Unmarshal(pkg.BeefTV, &manifest) != nil {
		// 没有 beeftv 的纯 pi 包合法；不是对象的 beeftv 由 ParsePluginPackageDir 报错。
		return nil
	}
	var problems []string
	problems = append(problems, unknownKeys("beeftv", manifest, packageManifestKeys)...)
	var configuration struct {
		Fields []map[string]json.RawMessage `json:"fields"`
	}
	if rawConfiguration, ok := manifest["configuration"]; ok && json.Unmarshal(rawConfiguration, &configuration) == nil {
		problems = append(problems, fieldProblems("beeftv.configuration.fields", configuration.Fields)...)
	}
	var contributes map[string]json.RawMessage
	if rawContributes, ok := manifest["contributes"]; ok && json.Unmarshal(rawContributes, &contributes) == nil {
		problems = append(problems, unknownKeys("beeftv.contributes", contributes, packageContributionKeys)...)
		var nodes []map[string]json.RawMessage
		if rawNodes, ok := contributes["canvasNodes"]; ok && json.Unmarshal(rawNodes, &nodes) == nil {
			for index, node := range nodes {
				problems = append(problems, unknownKeys(fmt.Sprintf("beeftv.contributes.canvasNodes[%d]", index), node, packageCanvasNodeKeys)...)
			}
		}
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("package.json 的 beeftv 写法需要修改：\n%s", strings.Join(problems, "\n"))
}

func fieldProblems(prefix string, fields []map[string]json.RawMessage) []string {
	var problems []string
	for index, field := range fields {
		problems = append(problems, unknownKeys(fmt.Sprintf("%s[%d]", prefix, index), field, packageFieldKeys)...)
	}
	return problems
}

func unknownKeys(prefix string, object map[string]json.RawMessage, allowed map[string]string) []string {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var problems []string
	for _, key := range keys {
		hint, known := allowed[key]
		switch {
		case !known:
			problems = append(problems, fmt.Sprintf("- %s.%s：BeefTV 不认识这一项", prefix, key))
		case hint != "":
			problems = append(problems, fmt.Sprintf("- %s.%s：%s", prefix, key, hint))
		}
	}
	return problems
}
