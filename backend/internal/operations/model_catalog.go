package operations

import (
	"encoding/json"
	"qisitv/backend/internal/modelcatalog"
)

type ModelCatalogReader interface {
	AgentModelCatalog() (*modelcatalog.CatalogResponse, error)
}

func registerModelCatalogOp(r *Registry) {
	r.Register(Op{AssistantCanvas: true, ID: "model.catalog", Summary: "按类型查询可用模型、参考能力与报价", ReadOnly: true, Scope: ScopeWorkspaceRead,
		Params: json.RawMessage(`{"type":"object","properties":{"capability":{"type":"string","enum":["text","image","video","audio"]},"capabilities":{"type":"array","items":{"type":"string","enum":["text","image","video","audio"]}}}}`),
		Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
			var args struct {
				Capability   string   `json:"capability"`
				Capabilities []string `json:"capabilities"`
			}
			if err := decodeParams(raw, &args); err != nil {
				return nil, err
			}
			if args.Capability != "" && len(args.Capabilities) > 0 {
				return nil, InvalidArg("invalid_capability", "capability 与 capabilities 请选择一种")
			}
			if args.Capability != "" {
				args.Capabilities = []string{args.Capability}
			}
			wanted := map[string]bool{}
			for _, capability := range args.Capabilities {
				switch capability {
				case "text", "image", "video", "audio":
					wanted[capability] = true
				default:
					return nil, InvalidArg("invalid_capability", "请选择 text、image、video 或 audio")
				}
			}
			reader, ok := ctx.Domain.(ModelCatalogReader)
			if !ok {
				return nil, Unsupported("model_catalog_unavailable", "当前工作区无法读取模型目录")
			}
			catalog, err := reader.AgentModelCatalog()
			if err != nil || catalog == nil {
				return catalog, mapDomainError(err)
			}
			all := len(wanted) == 0
			filtered := modelcatalog.NewCatalogResponse(catalog.Source, nil, nil)
			for _, item := range catalog.Models {
				if all || wanted[item.Capability] {
					filtered.Models = append(filtered.Models, item)
				}
			}
			for _, channel := range catalog.Channels {
				models := []modelcatalog.PublicChannelModel{}
				for _, item := range channel.Models {
					if all || wanted[item.Capability] {
						// Costs reach callers through generation.estimate and proposals;
						// raw price rows would only enlarge every catalog read.
						item.Pricing = nil
						models = append(models, item)
					}
				}
				if all || len(models) > 0 {
					channel.Models = models
					filtered.Channels = append(filtered.Channels, channel)
				}
			}
			return &filtered, nil
		}})
}
