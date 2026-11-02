package app

import (
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/modelcatalog"
)

func taskMediaFromProvider(media providerMedia) modelcatalog.MediaRef {
	return generation.TaskMediaFromProvider(media)
}

func taskMediaListFromProvider(items []providerMedia) []modelcatalog.MediaRef {
	return generation.TaskMediaListFromProvider(items)
}

func taskInputFromCanvas(input canvasGenerationInput) modelcatalog.TaskInput {
	return generation.TaskInputFromCanvas(input)
}

func applyTaskConfigToCanvas(input *canvasGenerationInput, task modelcatalog.TaskInput) {
	generation.ApplyTaskConfigToCanvas(input, task)
}
