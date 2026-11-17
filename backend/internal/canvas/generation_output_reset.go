package canvas

// inPlaceGenerationOutputFields 是节点上「这次生成的结果」相关字段。原地重做时
// 只解除节点与旧结果的绑定，资源本身仍留在素材库。
var inPlaceGenerationOutputFields = []string{
	"depthSourceNodeId", "content", "storageKey", "assetId", "resourceId", "url", "dataUrl",
	"previewContent", "videoPreview", "lastFrameUrl", "lastFrameStorageKey",
	"naturalWidth", "naturalHeight", "durationMs", "hasAudio", "bytes", "mimeType",
	"generationEffectKeys", "outputParameterWarning",
}

// ClearInPlaceGenerationOutput 清掉节点顶层与 metadata 里已展示的旧产物，让新的
// 原地生成从干净状态开始；旧资源不删除，仍可从素材库取回。返回是否有字段被清除。
func ClearInPlaceGenerationOutput(node map[string]any) bool {
	changed := clearOutputFields(node)
	if metadata, ok := node["metadata"].(map[string]any); ok {
		changed = clearOutputFields(metadata) || changed
	}
	return changed
}

func clearOutputFields(fields map[string]any) bool {
	changed := false
	for _, key := range inPlaceGenerationOutputFields {
		if _, present := fields[key]; present {
			delete(fields, key)
			changed = true
		}
	}
	return changed
}
