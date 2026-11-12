package main

import "testing"

func TestFitRectToWorkArea(t *testing.T) {
	for _, test := range []struct {
		name                 string
		window, work, expect startupWindowRect
	}{
		{
			name:   "1920x1200 at 125 percent",
			window: startupWindowRect{60, -30, 1860, 1170},
			work:   startupWindowRect{0, 0, 1920, 1140},
			expect: startupWindowRect{60, 0, 1860, 1140},
		},
		{
			name:   "both axes exceed a smaller work area",
			window: startupWindowRect{-37, -116, 1403, 844},
			work:   startupWindowRect{0, 0, 1366, 728},
			expect: startupWindowRect{0, 0, 1366, 728},
		},
		{
			name:   "monitor left of primary with taskbar on top",
			window: startupWindowRect{-2240, -400, -80, 1040},
			work:   startupWindowRect{-1920, -200, 0, 820},
			expect: startupWindowRect{-1920, -200, 0, 820},
		},
		{
			name:   "offscreen window fits after repositioning",
			window: startupWindowRect{100, -20, 1540, 940},
			work:   startupWindowRect{0, 0, 1920, 1140},
			expect: startupWindowRect{240, 90, 1680, 1050},
		},
		{
			name:   "window already fits a 4K work area at 200 percent",
			window: startupWindowRect{480, 96, 3360, 2016},
			work:   startupWindowRect{0, 0, 3840, 2112},
			expect: startupWindowRect{480, 96, 3360, 2016},
		},
		{
			name:   "empty work area does not shrink window",
			window: startupWindowRect{60, -30, 1860, 1170},
			expect: startupWindowRect{60, -30, 1860, 1170},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := fitRectToWorkArea(test.window, test.work); got != test.expect {
				t.Fatalf("fitRectToWorkArea() = %+v, want %+v", got, test.expect)
			}
		})
	}
}
