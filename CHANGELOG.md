# Changelog

All notable changes to `slopsmith-plugin-staffview` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added

- **MIDI input + note-detection scoring** — connects a MIDI keyboard and
  judges played notes against the loaded score (±100ms tolerance).
  - Device connection goes through the core `midi-input` capability domain
    (`window.feedBack.midiInput`) rather than a private
    `requestMIDIAccess()` — mirrors `plugins/keys_highway_3d`'s connection
    pattern (the piano effort's established contract): async-race-guarded
    connect (a generation counter discards a stale `open()` response after
    a rapid device switch), saved-device-pick persistence with
    name/id/key fallback matching, and recovery-only reconnect on
    `midi-input:sources-changed` (a transient unplug never substitutes a
    different device for an absent saved pick). Device + channel `<select>`
    row in the pill's new MIDI section, synced across every mounted pill
    instance.
  - In splitscreen, MIDI events route only to the currently-**focused**
    panel (`_ssActiveFull`/`onFocusChange`/`isCanvasFocused`, falling back
    to "always focused" when splitscreen lacks that surface) — the main
    player has only one panel, so this is a no-op there.
  - Reports hits/misses through the core **note-detection** capability
    domain rather than judging silently in isolation: registers once as a
    `'midi'` provider (idempotent across instances/song loads), opens a
    context-scoped binding per chart load (`{arrangement:'notation',
    midiLow, midiHigh}`, derived from the score's actual note range),
    and reports via `reportHit`/`reportMiss` — consumers own judgment,
    the domain only carries the observability event (spec 009 doctrine).
    A superseded binding from a rapid song switch is closed instead of
    stored, mirroring `keys_highway_3d`'s own supersession guard.
  - The provider registration and MIDI domain session are released only
    when the **last** staffview instance is torn down, not on every
    instance's destroy — a splitscreen sibling keeps both alive.
  - Suppresses the generic `note_detect` plugin's default singleton while
    a staffview instance is mounted, since staffview owns its own
    MIDI-based judgment over the same notes.
  - `_svParseMidiMessage()` (raw MIDI byte → normalized note-on/off/sustain
    event) extracted as a pure, unit-tested module-level helper.
  - Not included in this PR: audible feedback for the MIDI keyboard (no
    monitor synth yet — separately scoped) and visual hit/miss feedback on
    the score itself (miss-dots, hand coloring — also separately scoped;
    unlike the guitar/bass highway, staffview replaces the highway canvas
    entirely and has no "gems" to light via `setNoteStateProvider`).

### Fixed

- **Note-detection provider never registered for charts with no judge
  notes** — `_svNdOpenBindingForChart` computed the chart's MIDI range
  before registering the provider and returned early when the range came
  back `null`, skipping registration entirely rather than just skipping
  the (legitimately chart-dependent) binding. Registration is now
  unconditional, matching `keys_highway_3d`'s `_ndEnsureProvider()` —
  confirmed against the live `note-detection`/`midi-input` domain state
  (`capabilities.command(..., 'inspect', ...)`) that `staffview-midi`
  registers, opens a context-scoped binding, and reports real hit/miss
  events end-to-end.
- **MIDI device never showing in the pill's own dropdown** —
  `_svMidiNotifyDeviceListChanged()` calls
  `document.querySelectorAll('.sv-midi-select')` to update every mounted
  pill's select, but the pill's "populate immediately if the device list
  is already known" call ran while the popover DOM was still detached
  (built off-document, only attached to `document` once the whole `wrap`
  is appended at the very end of `_svCreatePill()`), so the query matched
  nothing and silently no-op'd. The domain-side connection was never
  affected — `capabilities.command('midi-input', 'inspect', ...)` showed
  the device correctly connected and open throughout — only this plugin's
  own UI never learned about it. Moved the call to after `wrap` is
  actually appended to the live document.
- **OGG loop drag-select** — clicking and dragging (mouse, ≥8px) or
  touch-dragging (≥14px, disarming on a predominantly-vertical first
  movement so vertical scroll still works) across the score sets a loop
  region via the platform's native `setLoop()` API, with a green overlay
  (start/end marker bars + a filled region, spanning multiple staff-system
  rows when the loop crosses a line break) that tracks it. The overlay also
  mirrors loops set through the platform's *own* native controls or a
  restored saved loop (`playback:loop-set` / `loop:restart` listeners,
  converting seconds → the nearest `AT` beat via `_svTimeToNearestBeat`,
  the inverse of the existing click-to-seek `_svBeatToSeconds`), and hides
  when the platform clears the loop (`playback:loop-cleared`) regardless of
  who set it. A generation counter (`_svLoopGen`) guards the async
  `setLoop()` round-trip against a stale response landing after the user
  cleared or re-dragged the loop. Teardown/song-switch only clears a loop
  *we* set (`_svOwnsOggLoop`) — a loop the user set through the platform's
  own controls is left alone.
  - Not ported from the legacy source: a pill-based `[A]`/`[B]`/`[✕]` button
    row and a section-jump `<select>` existed at one point but were removed
    there in favour of the platform's own native loop UI — this PR follows
    that same decision rather than reintroducing them.
  - `preventDefault()` on `touchend` after a drag suppresses the
    synthesized mousedown/click the browser would otherwise generate,
    so a drag gesture is never immediately followed by an accidental seek;
    `user-select:none` + a `selectstart` guard on the score's inner mount
    div prevent iOS's text-selection magnifier from firing mid-drag.

- **Note explorer** — alt/option-click (desktop) or double-tap (touch) a
  notehead to show a floating pitch tooltip instead of seeking; a plain
  click always seeks as before (the two are mutually exclusive per-click,
  gated on the alt key / tap-timing, not on beat content). One line per
  note in the beat (chord support), format `En / Sol` (e.g. `C#4 / DO#4`).
  Spelling honours `note.accidentalMode` (Force* values override) with a
  key-signature fallback (positive/zero key signature = sharp spelling,
  negative = flat), via `_svPitchLabel()` — a pure, unit-tested helper.
  Tooltip auto-dismisses after 4s or on the next mousedown/tap anywhere.
  Toggleable via a new NOTE EXPLORER pill section (default on, persisted
  to `localStorage`); double-tap uses `touch-action:manipulation` on the
  score's inner mount div to suppress the browser's native double-tap
  zoom.
  - **Known limitation (carried over from the original implementation):**
    on touch, the *first* tap of a double-tap doesn't call
    `preventDefault()` on its `touchend` (only the confirmed second tap
    does), so the browser's synthesized `mousedown` for that first tap
    still reaches the normal seek path — the marker briefly seeks to the
    tap position before the second tap's tooltip appears on top. Avoiding
    it cleanly would mean delaying every single-tap-to-seek on touch by
    the ~300ms double-tap window, which is a worse tradeoff for the common
    single-tap case. Left as a follow-up.

- **Options pill: LAYOUT and ZOOM controls** — reintroduces the ♩ Staff View
  pill removed alongside alphaSynth playback, now carrying only non-playback
  formatting controls. Mounts into the v3 plugin-control slot
  (`feedBack.ui.playerControlSlot()`, with a bounded poll + one-shot
  `MutationObserver` fallback for a not-yet-mounted slot), the v2
  `#player-footer`, or the splitscreen panel — using the platform's
  `.section-practice-pill` / `.section-practice-control` CSS classes so it
  looks native in both UI versions. The popover's outside-click listener is
  torn down on `_svRemovePill()` even if left open, so a mid-popover
  teardown never leaves a dangling `document`-level capture listener.
  - **LAYOUT** — `[Page]` / `[Horiz]` toggle `alphaTab.LayoutMode` with a
    full re-render; horizontal mode vertically centres the (single-row)
    staff in the container via flexbox, with an explicit `width:100%` on
    the inner mount div so alphaTab doesn't measure a 0-width flex child
    and skip rendering.
  - **ZOOM** — `[−]` / `[+]` adjust score scale in 5% steps, clamped
    50%–200% (`_svClampScale`, unit-tested), with a percentage readout and
    a reset-to-100% link.
  - Both persisted to `localStorage` (`staffview_layout`, `staffview_scale`)
    and read once at instance creation, applied as the `AlphaTabApi` initial
    `display.layoutMode` / `display.scale` (replacing the previous hardcoded
    `Page` / `0.9`).
  - Popover height is clamped to the visible viewport (`window.innerHeight`,
    not `vh`, since `vh` includes browser chrome) and capped at
    `max-height:80vh` with scroll, so it never runs off-screen on mobile.

### Fixed

- **Playback marker stale after LAYOUT/ZOOM change while paused** — a
  settings-only `updateSettings()`+`render()` (no score reload) doesn't
  reliably leave alphaTab's `boundsLookup` and the container's flex-centring
  reflow both settled by the time `renderFinished` fires; measured
  empirically, toggling layout could leave the marker positioned against
  bounds frozen from the *previous* layout, or against an unsettled
  container offset, invisible until the next play/seek forced a recompute.
  While playing, `_svSyncCursor` already re-triggers on every frame and
  papers over it — the bug only shows while paused. How long settling takes
  scales with the machine's speed and the score's layout complexity (note
  density, page/system count), not elapsed time, so any *fixed* delay —
  frame-count or wall-clock — can in principle still be too short on a slow
  enough machine or dense enough score. `_svSetLayout`/`_svSetScale` now
  poll `_svUpdateMarker()` (150ms interval, mirroring the pill's own
  bounded slot-retry pattern) and stop as soon as the marker's own computed
  position stops changing between two consecutive polls — the actual
  settlement signal — rather than after a fixed number of tries. A generous
  80-try (~12s) cap remains only as a safety net against a pathological
  case, not as the intended stop condition; the interval is cleared on
  teardown.

### Removed

- **alphaSynth playback** — AlphaTab playback is scrapped in favour of
  OGG-only playback: the host owns audio, matching tabview's rationale
  (`enablePlayer: false` drops the soundfont CDN download and the
  player-ready dependency). Removes the `♩ Staffview` pill with the
  Playback checkbox + `[⏮] [▶/⏸] [⏹]` transport, the OGG/alphaSynth
  mutual-exclusion bridge, the `playerPositionChanged` cursor path
  (the marker is now always driven by the `bundle.beats` stream), and
  the v3 slot retry/observer machinery that existed only for the pill.

### Fixed

- **Click-to-seek uses the `bundle.beats` time stream** — the clicked
  beat's tick is now converted to seconds by inverting the cursor-sync
  mapping (`tick = (beatIndex + frac) * 960`) against the host's beat
  timestamps, instead of a single-BPM approximation that landed on the
  wrong position in any tempo-varying song. The BPM path remains only as
  a fallback while beat data hasn't arrived yet.
- **Empty measures render a whole rest** — the empty-voice filler beat no
  longer sets `isEmpty = true`, which told alphaTab to skip the glyph
  entirely and left the measure blank. With no notes added alphaTab derives
  `isRest` from `notes.length === 0` and draws the whole-rest glyph.

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
- **v3 UI support** — the score container insets no longer assume the v2
  HUD/controls heights when those elements are `position:absolute` overlays
  in v3 (`window.slopsmith.uiVersion === 'v3'`).

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
