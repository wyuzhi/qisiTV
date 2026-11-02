package app

import (
	localproject "qisitv/backend/internal/project"
)

type CreateProjectShotRequest = localproject.CreateProjectShotRequest
type ShotRevisionInput = localproject.ShotRevisionInput
type ReplaceProjectUnitShotsRequest = localproject.ReplaceProjectUnitShotsRequest
type ReplaceProjectUnitShotInput = localproject.ReplaceProjectUnitShotInput
type LinkShotAssetRequest = localproject.LinkShotAssetRequest
type AssetCandidateInput = localproject.AssetCandidateInput
type CreateAssetCandidatesRequest = localproject.CreateAssetCandidatesRequest

const assetCandidateSourceChapterCharacter = localproject.AssetCandidateSourceChapterCharacter
