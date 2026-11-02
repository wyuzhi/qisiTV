package playback

import (
	"encoding/binary"
	"io"
)

// ProbeVideoReader reads only bounded MP4 metadata, never the large mdat body.
// It accepts the seekable/spooled source already used by direct uploads.
func ProbeVideoReader(source io.ReaderAt, size int64) (int, int, int64) {
	for offset := int64(0); offset+8 <= size; {
		kind, boxSize, err := readMP4BoxHeaderAt(source, offset)
		if err != nil || boxSize > size-offset {
			return 0, 0, 0
		}
		if kind == "moov" {
			if boxSize > probeMaxMoov {
				return 0, 0, 0
			}
			data := make([]byte, boxSize)
			if _, err := source.ReadAt(data, offset); err != nil {
				return 0, 0, 0
			}
			// Normalize an extended-size box to the parser's ordinary moov form.
			if binary.BigEndian.Uint32(data[:4]) == 1 {
				copy(data[8:], data[16:])
				data = data[:len(data)-8]
				binary.BigEndian.PutUint32(data[:4], uint32(len(data)))
			}
			return ProbeGeneratedVideoMedia(data)
		}
		offset += boxSize
	}
	return 0, 0, 0
}
