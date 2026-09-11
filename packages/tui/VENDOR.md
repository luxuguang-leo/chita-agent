# pi-tui vendor notes

This directory vendors `packages/tui` from `earendil-works/pi` (TUI architecture design §6).

## Source

- Repository: https://github.com/earendil-works/pi
- Package: `packages/tui` (@earendil-works/pi-tui)
- **commit: `7bdb16c28d794a5ff8e7485479c8e37eccd9a8d8`** (2026-08-08)
- License: MIT (copy below)

## Vendored contents

- `src/` → 37 .ts files (plain-JS core; `native-modifiers.ts` excluded)
- **Excluded**: `native/` (darwin/win32 native .node modifier-key detection) — degraded to regular key detection, no functional impact (design §6 decision)
- Dependencies: `get-east-asian-width` / `marked` (already present in the chita workspace)

## Supply-chain pinning

- commit + hash recorded in this file (immutable source)
- `SessionMeta.pinnedResources` records the vendor version (v2.1 N2 mechanism)
- Upgrade flow: update source commit → re-vendor → update this file → update pinnedResources

## Modification log

| Date | Change |
|---|---|
| 2026-08-09 | initial vendor copy; terminal.ts drops the native-modifiers import (native Shift+Enter detection degraded to false) |


## LICENSE (MIT, from the pi repo)

MIT License

Copyright (c) 2024 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
| 2026-08-09 | components/editor.ts: the newLine branch drops the bare `\n` fallback — with the TUI's setKeybindings override, Enter submits and Shift+Enter inserts a newline (chita design §8) |
