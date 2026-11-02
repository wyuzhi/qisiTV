package desktopupdate

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"fmt"
	"io"
)

const (
	binaryPatchMagic   = "BTDELTA1"
	binaryPatchHdrSize = 24
	maxPatchControls   = 4 * 1024 * 1024
)

// BuildBinaryPatch computes a pure-Go compressed binary patch (BTDELTA1)
// transforming oldData into newData using approximate block matching and
// byte-wise difference streams.
func BuildBinaryPatch(oldData, newData []byte) ([]byte, error) {
	if uint64(len(oldData)) > maxZipEntry || uint64(len(newData)) > maxZipEntry {
		return nil, ErrInvalidArchive
	}
	const stride = 32
	numBlocks := len(oldData) / stride
	tableBits := 10
	for tableBits < 22 && (1<<tableBits) < numBlocks*2 {
		tableBits++
	}
	tableSize := 1 << tableBits
	tableMask := uint64(tableSize - 1)
	table0 := make([]int32, tableSize)
	table1 := make([]int32, tableSize)
	for i := range table0 {
		table0[i] = -1
		table1[i] = -1
	}

	for off := 0; off+16 <= len(oldData); off += stride {
		v0 := binary.LittleEndian.Uint64(oldData[off : off+8])
		v1 := binary.LittleEndian.Uint64(oldData[off+8 : off+16])
		if v0 == 0 && v1 == 0 {
			continue
		}
		h := hashPatchBlock16(v0, v1) & tableMask
		table1[h] = table0[h]
		table0[h] = int32(off)
	}

	var ctrlBuf bytes.Buffer
	var diffBuf bytes.Buffer
	var extraBuf bytes.Buffer

	lastscan := 0
	lastpos := 0
	lastoffset := 0
	scan := 0

	emitControl := func(addLen, extraLen int, seekOff int64) {
		var rec [16]byte
		binary.LittleEndian.PutUint32(rec[0:4], uint32(addLen))
		binary.LittleEndian.PutUint32(rec[4:8], uint32(extraLen))
		binary.LittleEndian.PutUint64(rec[8:16], uint64(seekOff))
		ctrlBuf.Write(rec[:])
	}

	emitDiff := func(startScan, startPos, length int) {
		if length <= 0 {
			return
		}
		part := make([]byte, length)
		for i := 0; i < length; i++ {
			part[i] = newData[startScan+i] - oldData[startPos+i]
		}
		diffBuf.Write(part)
	}

	for scan < len(newData) {
		f := extendForwardMatch(oldData, newData, lastpos, lastscan)
		scan = lastscan + f
		if scan >= len(newData) {
			emitDiff(lastscan, lastpos, f)
			emitControl(f, 0, 0)
			break
		}

		foundScan, foundPos := findNextPatchAnchor(oldData, newData, scan, lastoffset, table0, table1, tableMask)
		if foundPos < 0 {
			emitDiff(lastscan, lastpos, f)
			extraLen := len(newData) - (lastscan + f)
			extraBuf.Write(newData[lastscan+f:])
			emitControl(f, extraLen, 0)
			break
		}

		lenb := extendBackwardMatch(oldData, newData, foundPos, foundScan, lastscan+f)
		emitDiff(lastscan, lastpos, f)

		nextScan := foundScan - lenb
		nextPos := foundPos - lenb
		extraLen := nextScan - (lastscan + f)
		if extraLen > 0 {
			extraBuf.Write(newData[lastscan+f : nextScan])
		}
		emitControl(f, extraLen, int64(nextPos-(lastpos+f)))

		lastscan = nextScan
		lastpos = nextPos
		lastoffset = nextPos - nextScan
		scan = nextScan
	}

	var out bytes.Buffer
	out.WriteString(binaryPatchMagic)
	var hdr [16]byte
	binary.LittleEndian.PutUint64(hdr[0:8], uint64(len(newData)))
	binary.LittleEndian.PutUint64(hdr[8:16], uint64(ctrlBuf.Len()/16))
	out.Write(hdr[:])

	zw, err := flate.NewWriter(&out, flate.DefaultCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(ctrlBuf.Bytes()); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if _, err := zw.Write(diffBuf.Bytes()); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if _, err := zw.Write(extraBuf.Bytes()); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func hashPatchBlock16(v0, v1 uint64) uint64 {
	h := v0 ^ (v1 * 0x9e3779b97f4a7c15)
	h ^= h >> 33
	h *= 0xff51afd7ed558ccd
	h ^= h >> 33
	return h
}

func extendForwardMatch(oldData, newData []byte, lastpos, lastscan int) int {
	score := 0
	best := 0
	f := 0
	maxI := len(newData) - lastscan
	if len(oldData)-lastpos < maxI {
		maxI = len(oldData) - lastpos
	}
	for i := 0; i < maxI; i++ {
		if oldData[lastpos+i] == newData[lastscan+i] {
			score++
		}
		if 2*score-(i+1) >= 2*best-f {
			best = score
			f = i + 1
		} else if (2*best-f)-(2*score-(i+1)) > 96 {
			break
		}
	}
	return f
}

func extendBackwardMatch(oldData, newData []byte, foundPos, foundScan, minScan int) int {
	score := 0
	best := 0
	lenb := 0
	maxB := foundScan - minScan
	if foundPos < maxB {
		maxB = foundPos
	}
	for i := 1; i <= maxB; i++ {
		if oldData[foundPos-i] == newData[foundScan-i] {
			score++
		}
		if 2*score-i > 2*best-lenb {
			best = score
			lenb = i
		} else if (2*best-lenb)-(2*score-i) > 64 {
			break
		}
	}
	return lenb
}

func findNextPatchAnchor(oldData, newData []byte, scan, lastoffset int, table0, table1 []int32, tableMask uint64) (int, int) {
	for s := scan; s+16 <= len(newData); s++ {
		if (s-scan)&7 == 0 {
			if o := s + lastoffset; o >= 0 && o+32 <= len(oldData) && s+32 <= len(newData) {
				m := 0
				for k := 0; k < 32; k++ {
					if oldData[o+k] == newData[s+k] {
						m++
					}
				}
				if m >= 24 {
					return s, o
				}
			}
		}
		v0 := binary.LittleEndian.Uint64(newData[s : s+8])
		v1 := binary.LittleEndian.Uint64(newData[s+8 : s+16])
		if v0 == 0 && v1 == 0 {
			continue
		}
		h := hashPatchBlock16(v0, v1) & tableMask
		for _, cand32 := range [2]int32{table0[h], table1[h]} {
			if cand32 < 0 {
				continue
			}
			cand := int(cand32)
			if !bytes.Equal(oldData[cand:cand+16], newData[s:s+16]) {
				continue
			}
			m := 16
			lim := 32
			if s+lim > len(newData) {
				lim = len(newData) - s
			}
			if cand+lim > len(oldData) {
				lim = len(oldData) - cand
			}
			for k := 16; k < lim; k++ {
				if oldData[cand+k] == newData[s+k] {
					m++
				}
			}
			if m >= 22 {
				return s, cand
			}
		}
	}
	return len(newData), -1
}

// ApplyBinaryPatch reconstructs newData from oldData and a BTDELTA1 patch.
func ApplyBinaryPatch(oldData, patch []byte) ([]byte, error) {
	if len(patch) < binaryPatchHdrSize || string(patch[:8]) != binaryPatchMagic {
		return nil, fmt.Errorf("%w: invalid binary patch header", ErrInvalidArchive)
	}
	newSize64 := binary.LittleEndian.Uint64(patch[8:16])
	numCtrl64 := binary.LittleEndian.Uint64(patch[16:24])
	if newSize64 > maxZipEntry || numCtrl64 > maxPatchControls || numCtrl64 > newSize64+1 {
		return nil, fmt.Errorf("%w: binary patch header exceeds limits", ErrInvalidArchive)
	}
	newSize := int(newSize64)
	numCtrl := int(numCtrl64)

	rawReader := bytes.NewReader(patch[binaryPatchHdrSize:])
	zr := flate.NewReader(rawReader)
	defer zr.Close()

	ctrlBytes := make([]byte, numCtrl*16)
	if _, err := io.ReadFull(zr, ctrlBytes); err != nil {
		return nil, fmt.Errorf("%w: truncated patch control stream", ErrInvalidArchive)
	}

	type patchCtrl struct {
		addLen   int
		extraLen int
		seekOff  int64
	}
	ctrls := make([]patchCtrl, numCtrl)
	var totalDiff, totalExtra uint64
	for i := 0; i < numCtrl; i++ {
		off := i * 16
		a := binary.LittleEndian.Uint32(ctrlBytes[off : off+4])
		e := binary.LittleEndian.Uint32(ctrlBytes[off+4 : off+8])
		s := int64(binary.LittleEndian.Uint64(ctrlBytes[off+8 : off+16]))
		totalDiff += uint64(a)
		totalExtra += uint64(e)
		if totalDiff+totalExtra > newSize64 {
			return nil, fmt.Errorf("%w: patch control lengths exceed target size", ErrInvalidArchive)
		}
		ctrls[i] = patchCtrl{addLen: int(a), extraLen: int(e), seekOff: s}
	}
	if totalDiff+totalExtra != newSize64 {
		return nil, fmt.Errorf("%w: patch control lengths do not match target size", ErrInvalidArchive)
	}

	diffBytes := make([]byte, int(totalDiff))
	if _, err := io.ReadFull(zr, diffBytes); err != nil {
		return nil, fmt.Errorf("%w: truncated patch diff stream", ErrInvalidArchive)
	}
	extraBytes := make([]byte, int(totalExtra))
	if _, err := io.ReadFull(zr, extraBytes); err != nil {
		return nil, fmt.Errorf("%w: truncated patch extra stream", ErrInvalidArchive)
	}
	var trailing [1]byte
	if n, err := zr.Read(trailing[:]); n != 0 || (err != nil && err != io.EOF) || rawReader.Len() != 0 {
		return nil, fmt.Errorf("%w: unexpected trailing bytes in binary patch", ErrInvalidArchive)
	}

	newData := make([]byte, newSize)
	var oldPos int64
	newPos := 0
	diffPos := 0
	extraPos := 0
	oldLen := int64(len(oldData))
	for _, c := range ctrls {
		if c.addLen > 0 {
			if oldPos < 0 || oldPos+int64(c.addLen) > oldLen || newPos+c.addLen > newSize {
				return nil, fmt.Errorf("%w: patch add range out of bounds", ErrInvalidArchive)
			}
			src := oldData[int(oldPos) : int(oldPos)+c.addLen]
			dif := diffBytes[diffPos : diffPos+c.addLen]
			dst := newData[newPos : newPos+c.addLen]
			for i := 0; i < c.addLen; i++ {
				dst[i] = src[i] + dif[i]
			}
			newPos += c.addLen
			oldPos += int64(c.addLen)
			diffPos += c.addLen
		}
		if c.extraLen > 0 {
			if newPos+c.extraLen > newSize {
				return nil, fmt.Errorf("%w: patch extra range out of bounds", ErrInvalidArchive)
			}
			copy(newData[newPos:newPos+c.extraLen], extraBytes[extraPos:extraPos+c.extraLen])
			newPos += c.extraLen
			extraPos += c.extraLen
		}
		oldPos += c.seekOff
	}
	if newPos != newSize {
		return nil, fmt.Errorf("%w: incomplete binary patch output", ErrInvalidArchive)
	}
	return newData, nil
}
