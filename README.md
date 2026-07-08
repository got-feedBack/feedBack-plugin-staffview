# Staff View

Standard notation (grand staff) viewer for [FeedBack](https://github.com/got-feedBack/feedBack), with MIDI-keyboard practice built in: live hit/miss scoring, hand isolation, and a note-by-note gated study mode. Rendered via [alphaTab](https://alphatab.net).

Renders any arrangement that carries notation data in the `.sloppak` chart format — no backend conversion, no extra HTTP request; the plugin builds an `alphaTab.model.Score` directly in JavaScript from the highway WebSocket stream.

## How it works

- **Auto-activates** (`matchesArrangement`) when the loaded arrangement has `has_notation: true`.
- Accumulates `notation_info` / `notation_measures` over a per-instance WebSocket connection and calls `AlphaTabApi.renderScore()`.
- **No local synth** — the host owns audio (OGG); `enablePlayer:false` drops alphaTab's own soundfont download. The cursor tracks the host's `bundle.beats` time stream (binary search → MIDI tick → `boundsLookup.findBeat()` → marker geometry).
- Options pill (v3 plugin-control slot / v2 `#player-footer` / splitscreen panel), sections persisted to `localStorage`:
  - **NOTE DETECTION** — master Detect on/off, and whether seeking clears miss-dots for the replayed region.
  - **STUDY** — note-by-note gated practice (see below).
  - **HAND** — RH/LH isolation on grand-staff scores, via alphaTab's native note colouring.
  - **MIDI** — device + channel picker (core `midi-input` domain), monitor-synth Sound + Volume.
  - **LAYOUT** / **ZOOM** — page vs. horizontal layout, 50–200% zoom.

### Practice features

- **MIDI input & scoring** — connects through the core `midi-input` capability domain (mirrors `plugins/keys_highway_3d`); note-on/off is judged against the loaded score (±100ms) and reported through the core **note-detection** domain (`register-provider` / `open-binding` / `reportHit`/`reportMiss`) — staffview owns judgment, the domain only carries the observability event.
- **Miss-dot overlay** — a small dot marks any notehead whose hit window passed un-played; a monotonic sweep runs each frame, and a seek in either direction re-syncs without false-marking the jumped span.
- **Core stats bridge** — judged hits/misses feed core's live HUD, dashboard, and `song_stats` (`note:hit`/`note:miss`), including an injected RH/LH accuracy line on grand-staff scores. The scoreboard is repositioned to the bottom-right while staffview is showing notation.
- **Monitor synth** — a [WebAudioFont](https://github.com/surikov/webaudiofont)-based synth plays back your MIDI keyboard (own CDN; keyboard tones aren't yet a core capability), with instrument/volume controls and a mixer fader.
- **Study mode** — the OGG pauses at each gate (a beat's required notes) and only resumes once they're all played correctly; wrong notes draw a clef-aware X at the pitch actually played. Study is **unscored practice**: it doesn't feed the live HUD or `song_stats` (a step-by-step run is always ~100% by construction), only the note-detection domain for observability. Optional metronome preroll count-in.
- **Note explorer** — alt-click (desktop) / double-tap (touch) a notehead for a pitch tooltip, without triggering seek.
- **OGG loop** — click-drag (or touch-drag) across the score sets a loop region via the platform's native `setLoop()` API, with a green overlay that mirrors loops set through the platform's own controls.

## Install

Copy or symlink this directory into your FeedBack `plugins/` folder:

```
plugins/
  staffview/    ← this repo
```

alphaTab is loaded from the jsDelivr CDN at runtime — no local build step needed.

## Tests

Browser-free host-integration helpers have a `node:test` suite:

```sh
npm test
```

## License

AGPL-3.0-only — see [LICENSE](LICENSE).

Originally prototyped by [Gionni](https://github.com/gionnibgud); curated
into the org for the piano/keys epic.
