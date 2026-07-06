# Changelog

All notable changes to `slopsmith-plugin-staffview` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed

- **Migrated to the `window.feedBack` namespace** — the host bus
  (`.on`/`.off`), `uiVersion`, and `ui.playerControlSlot()` reads now go
  through `window.feedBack` instead of the pre-rename `window.slopsmith`
  alias. `window.feedBackViz_staffview` is now the sole viz-picker
  registration (the picker only ever looked up `feedBackViz_<id>`; the old
  `slopsmithViz_staffview` name had no consumer and has been dropped).
  Splitscreen detection reads `window.feedBackSplitscreen` first, falling
  back to `window.slopsmithSplitscreen` since the published splitscreen
  plugin currently only exports the latter — this fallback stays until
  splitscreen itself is renamed.

- **Curated into the slopsmith org** (slopsmith#823, epic slopsmith#828):
  `private: false`, one-line `description`, and the promoted
  `visualization` capability declaration (`standards` +
  `capabilities.visualization`, slopsmith#836) added to `plugin.json`.
- **License** — relicensed MIT → AGPL-3.0-only per the curated-plugin
  licensing policy (CONTRIBUTING.md); attribution to the original author
  (Gionni) kept in the README.
- **v3 UI support** — the `♩ Staffview` pill now mounts into
  `window.slopsmith.ui.playerControlSlot()` when
  `window.slopsmith.uiVersion === 'v3'` (the v2 `#player-footer` path is
  unchanged), and the score container insets no longer assume the v2
  HUD/controls heights when those elements are absent in v3.

---

## [0.2.0] — 2026-06-11

### Changed

- **Playback UI — independent transport controls** — replaced the
  "Playback" checkbox-only popover with an inline control row:
  `[✓] Playback  [⏮] [▶/⏸] [⏹]`. The checkbox reveals the transport
  buttons; the buttons drive alphaSynth independently of the slopsmith
  song control. Ticking the checkbox no longer auto-starts alphaSynth —
  the user hits ▶ explicitly.
- **OGG/alphaSynth mutual exclusion** — when the user hits ▶ in the
  staffview popover, the OGG `<audio>` element is paused (`audio.pause()`)
  and `_svOggPausedByUs` is set. When alphaSynth stops or finishes, OGG
  is restored (`audio.play()`). Conversely, if the slopsmith play button
  is pressed while alphaSynth is running, alphaSynth yields (pauses) and
  OGG takes over. Neither source steals the cursor from the other.
- **Simplified transport bridge** — `_svInstallSongBridge` now only
  listens for two events: native `<audio>` `'play'` (OGG took over →
  pause alphaSynth) and slopsmith bus `song:stop` (song switch →
  stop alphaSynth). Seek guard, end guard, and `'pause'` mirror removed
  — these were artefacts of the old "follow OGG" model.
- **`playerFinished` restores OGG** — when the score plays to the end,
  alphaSynth resets to tick 0, the ▶ button resets so the user can play
  again, and OGG is resumed if we had paused it.

### Added

- **alphaSynth player** — `enablePlayer: true` with sonivox SoundFont
  loaded from the alphaTab CDN. alphaTab's built-in synth renders the
  notation as audio (Scenario 1: notation playback study mode).
- **Dual cursor path** — `playerPositionChanged` (currentTick, ~50 ms
  interval) drives the marker when alphaSynth is playing; the existing
  `bundle.beats` binary-search path remains active when it is not
  (Scenario 3: OGG backing track).
- `_clefValue()` helper — clef string → alphaTab Clef enum value.
- `_makeTempoAutomation()` helper — duck-typed tempo automation object.

### Fixed

- **Pause not stopping alphaSynth** — the HTML5 `togglePlay()` path
  calls `audio.pause()` without emitting `song:pause` on the bus.
  Resolved by relying solely on slopsmith bus events; app.js's native
  `audio` `pause` listener does emit `song:pause` (gated on `isPlaying`)
  which the bridge correctly receives.
- **Double-stop / AudioNode corruption on teardown** — `_svInitAlphaTab`
  now calls `api.stop()` before `api.destroy()` when replacing an
  existing instance, preventing the worker from receiving a destroy while
  an AudioNode is still running.
- **End-of-song loop** — direct `audio` element `play`/`pause` listeners
  were reinstalled on every `renderFinished` reflow and fired on every
  `audio.play()` call including slopsmith's jump-fix recovery seeks,
  causing alphaSynth to restart at the end of the track in an infinite
  loop. Fixed by: (a) moving bridge installation out of `renderFinished`
  into `_svTryRender` (once per load); (b) removing all direct audio
  element listeners — the slopsmith bus events are sufficient.
- **Replay after end-of-song failed** — our `playerFinished` handler was
  calling `api.stop()` after alphaSynth had already called its own
  internal `stop()`. The double-stop posted a redundant stop message to
  the worker, corrupting AudioNode state and preventing subsequent
  `api.play()` calls from succeeding. AlphaSynth leaves state as Paused
  at tick 0 after its internal stop; our handler now only resets cursor
  tracking (`_svPlayerTick = -1`).

- **White background** — container was `background:#1a1a2e` (dark) but
  alphaTab renders black ink on its own SVG surfaces with no internal
  fill; the dark background made notation invisible. Changed to `#fff`.
- **Note octave off by one** — `note.octave` was computed as
  `Math.floor(midi/12) - 1`. alphaTab's internal convention (verified
  from 1.8.2 minified source) is `octave = midi/12|0` with no offset.
  Removed the `- 1`.
- **Only first track rendered** — `api.renderScore(score)` with no
  second argument renders track 0 only. Fixed by passing explicit
  track index array. Now passes `[0]` (single track per instrument).
- **Grand staff brace missing; two separate staves** — all sloppak
  staves for an instrument were built as separate alphaTab `Track`
  objects. alphaTab only draws a grand-staff brace when multiple staves
  share one `Track`. Reworked `_buildScore` to create one `Track` with
  N `Staff` objects (one per sloppak staff def).
- **Clef enum values wrong** — G2 was mapped to 1 and F4 to 4; correct
  values from source are G2=4, F4=3, C3=1, C4=2, Neutral=0. Bass-clef
  staves were rendering with a treble glyph.
- **Tempo mark missing** — `score.tempo` is a getter reading
  `masterBars[0].tempoAutomations[0].value`; there is no setter.
  Fixed by pushing a duck-typed automation object onto
  `masterBar.tempoAutomations` for the first measure and any
  tempo-change measure.
- **Rests not rendering** — authored rests were marked with
  `beat.isEmpty = true`, which tells alphaTab to skip rendering
  entirely (no glyph). For a visible rest symbol, `isEmpty` must stay
  `false` and no notes added; alphaTab then computes `isRest = true`
  via `notes.length === 0` and draws the rest glyph.
- **Accidental overrides not wired** — sloppak `nd.acc` field was
  parsed by the spec but never mapped to the alphaTab model. Wired to
  `note.accidentalMode` using verified enum values: `acc=0` →
  ForceNatural(2), `acc=1` → ForceSharp(3), `acc=2` →
  ForceDoubleSharp(4), `acc=-1` → ForceFlat(5), `acc=-2` →
  ForceDoubleFlat(6).
- **README cursor sync description stale** — described
  `IExternalMediaHandler` / `PlayerMode.EnabledExternalMedia` which is
  not implemented. Updated to describe the actual `bundle.beats` binary
  search → tick → `boundsLookup.findBeat()` path.

---

## [0.1.0] — 2026-06-11 (initial commit)

### Added

- `plugin.json` — manifest: `type: visualization`, `script: screen.js`,
  `private: true`. No nav, no routes, no screen.html.
- `screen.js` — setRenderer factory (`window.slopsmithViz_staffview`).
  - Per-instance WS connection to `/ws/highway/{filename}?arrangement={idx}`
    accumulates `notation_info` + `notation_measures` messages, closes after
    `ready`. No backend route — notation data arrives over the existing
    highway WebSocket (server.py `feat/notation-format` branch).
  - Builds `alphaTab.model.Score` directly in JS from the accumulated data.
    Note pitch via `note.octave` + `note.tone` from MIDI (sloppak-spec §5.7
    piano note path — no string/fret/tuning indirection).
  - Calls `score.finish()` then `api.renderScore(score)` — no format
    conversion, no extra HTTP request.
  - `staveProfile: Score` — standard notation only, no tablature staff.
  - `enablePlayer: false` — slopsmith owns audio.
  - Cursor sync: `bundle.beats` → binary search → MIDI tick →
    `absoluteDisplayStart` → `boundsLookup.findBeat()` → marker geometry.
  - `matchesArrangement` static: activates when `songInfo.has_notation`.
  - Painted-to-painted handoff, splitscreen-aware mount, ResizeObserver,
    error banner, teardown, monotonic init token.
- `LICENSE` — MIT.
- `README.md`, `CHANGELOG.md`, `.gitignore`.

### Requires

Slopsmith `feat/notation-format` branch or later.
