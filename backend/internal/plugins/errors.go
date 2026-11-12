package plugins

import "qisitv/backend/internal/kernel"

// AccessError is a caller-facing authorization failure. Host adapters map it
// onto the HTTP forbidden contract without the domain importing internal/app.
type AccessError struct {
	Message string
}

func (e *AccessError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func Forbidden(message string) error {
	return &AccessError{Message: message}
}

// packageError is a caller-facing package failure with a machine-readable
// reason, so HTTP adapters never have to parse the message text.
func packageError(status int, reason, message string) error {
	return &kernel.AppError{Status: status, Code: status, Reason: kernel.ErrorReason(reason), Message: message}
}
