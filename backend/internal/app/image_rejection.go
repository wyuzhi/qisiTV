package app

import (
	"qisitv/backend/internal/mediaattempt"
)

func definiteImageInputRejection(err error) bool {
	return mediaattempt.DefiniteImageInputRejection(err)
}
