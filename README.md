# slopsmith-plugin-staffview

Standard notation viewer for [Slopsmith](https://github.com/got-feedback/feedback).

Renders musical notation (treble/bass clef, grand staff, etc.) for any
arrangement that carries notation data in the sloppak format, using
[alphaTab](https://alphatab.net).

**Requires:** a Slopsmith build with the sloppak notation schema
(`docs/sloppak-spec.md` §5.3, slopsmith#838) — currently the
`feat/notation-schema-v1` branch.

---

## How it works

- Activates automatically (Auto mode) when the loaded arrangement has
  `has_notation: true` in the highway `song_info` message.
- Accumulates `notation_info` + `notation_measures` WebSocket messages
  and builds an `alphaTab.model.Score` object directly in JavaScript.
- Renders via `AlphaTabApi.renderScore()` — no backend conversion, no
  extra HTTP request.
- **OGG mode (default):** cursor synchronises via `bundle.beats` (the
  highway WebSocket beats stream): binary search → MIDI tick (960 ppq)
  → `boundsLookup.findBeat()` → marker geometry. Audio plays normally
  via slopsmith.
- **Playback mode:** a `♩ Staffview ▾` pill in the player footer exposes
  transport controls. Enabling it activates alphaSynth (Sonivox SoundFont
  from the alphaTab CDN); the cursor is then driven by
  `playerPositionChanged` (currentTick). The OGG audio element is muted
  for the duration.

## Install

Copy or symlink this directory into your Slopsmith `plugins/` folder:

```
plugins/
  staffview/    ← this repo
```

alphaTab is loaded from the jsDelivr CDN at runtime — no local build step needed.

## License

AGPL-3.0-only — see [LICENSE](LICENSE).

Copyright (c) 2025-2026 Gionni (gionnibgud@gmail.com) and contributors.
Originally prototyped by [Gionni](https://github.com/gionnibgud); curated
into the Slopsmith org for the piano/keys epic (slopsmith#828).
