package generation

type ImageRecoveryError struct{ Cause error }

// This wrapper is only used before the first transport call; it cannot imply
// that a supplier accepted the request or started a paid generation.
type ImagePreparationError struct{ Cause error }

func (e ImagePreparationError) Error() string {
	return "图片请求在本地准备时失败，尚未提交到模型服务"
}
func (e ImagePreparationError) Unwrap() error { return e.Cause }

func (e ImageRecoveryError) Error() string {
	return "图片结果尚未确认，已停止自动重发；请保留任务记录并联系支持查询结果"
}
func (e ImageRecoveryError) Unwrap() error { return e.Cause }
