package mediaattempt

import "infinite-canvas/backend/internal/generation"

// A completed input rejection ends this attempt. It does not authorize an
// automatic resend, and cannot erase an earlier accepted or uncertain request.
// Historical summaries omit replay headers and JSON job IDs; they cannot
// reconstruct this decision or unlock a task whose submission is still unknown.
func DefiniteImageInputRejection(err error) bool {
	if IsImageRecoveryError(err) {
		return false
	}
	return generation.DefiniteImageInputRejection(err)
}
