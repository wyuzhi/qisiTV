package canvasworkflow

import (
	"encoding/json"
	"strings"

	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/providerpreset"
)

// officialLegacyIDs are IDs the official channel was saved under in earlier
// releases (before v2.2.0 it was "beefapi"), declared by the official preset.
func officialLegacyIDs() []string {
	for _, preset := range providerpreset.BuiltinChannels() {
		if preset.ID == beeftv.ChannelID {
			return preset.LegacyIDs
		}
	}
	return nil
}

// IsOfficialWorkflowChannel reports whether a saved workflow recipe runs on the
// official channel, including recipes saved under a former official ID.
func IsOfficialWorkflowChannel(channelID string) bool {
	if channelID == "@beeftv" {
		return true
	}
	for _, legacy := range officialLegacyIDs() {
		if channelID == "@"+legacy {
			return true
		}
	}
	return false
}

// UnmarshalJSON reads every saved workflow node through one place, so a node
// saved before the official channel was renamed ("beefapi::model" or
// channelId "beefapi") runs and displays on the current official channel.
func (n *Node) UnmarshalJSON(data []byte) error {
	type plain Node
	if err := json.Unmarshal(data, (*plain)(n)); err != nil {
		return err
	}
	if n.Config == nil {
		return nil
	}
	for _, legacy := range officialLegacyIDs() {
		if option, ok := n.Config["modelOption"].(string); ok && strings.HasPrefix(option, legacy+"::") {
			n.Config["modelOption"] = beeftv.ChannelID + option[len(legacy):]
		}
		if channel, ok := n.Config["channelId"].(string); ok && channel == legacy {
			n.Config["channelId"] = beeftv.ChannelID
		}
	}
	return nil
}
