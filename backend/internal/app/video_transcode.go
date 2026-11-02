package app

import (
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/playback"
)

var ErrPlaybackNotReady = playback.ErrNotReady

func probeGeneratedVideoMedia(data []byte) (int, int, int64) {
	return playback.ProbeGeneratedVideoMedia(data)
}
func probeVideoCodec(path string) string                     { return playback.ProbeCodec(path) }
func firstMP4Payload(data []byte, pos, end int, w string) []byte { return playback.FirstPayload(data, pos, end, w) }
func mp4Payloads(data []byte, want string) [][]byte          { return playback.Payloads(data, want) }
func trakHandlerType(trak []byte) string                     { return playback.TrackHandler(trak) }
func (s *Service) maybeStartPlaybackTranscode(r *model.Resource) { s.playbackRuntime().MaybeStart(r) }
func (s *Service) RecoverPlaybackTranscodes()                { logPlaybackRecovery(s.playbackRuntime().Recover()) }

func (s *Service) PrepareResourcePlayback(userID, resourceID string) (*model.Resource, error) {
	resource, err := s.Resource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	if err := s.playbackRuntime().Prepare(resource); err != nil {
		return nil, err
	}
	return s.Resource(userID, resourceID)
}
