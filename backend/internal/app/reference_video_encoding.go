package app

import "qisitv/backend/internal/generation"

func referenceVideoEncoding(data []byte) (string, float64) {
	return generation.ReferenceVideoEncoding(data)
}

func referenceVideoFrameRateError(config providerConfig, index int, fps float64) error {
	return generation.ReferenceVideoFrameRateError(config, index, fps)
}
