package app

import "qisitv/backend/internal/generation"

const likeAIBaseURL = generation.LikeAIBaseURL

func isLikeAIProtocol(id string) bool { return generation.IsLikeAIProtocol(id) }
