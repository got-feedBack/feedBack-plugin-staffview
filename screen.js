// staffview — screen.js
// Renders standard musical notation for any arrangement that carries
// notation_info / notation_measures WS messages, via alphaTab.
//
// Architecture overview:
//   - setRenderer contract (CLAUDE.md §Plugin Best Practices, slopsmith#36)
//   - No backend route — notation data arrives over the existing highway WS
//   - Per-instance WS connection to /ws/highway/{filename}?arrangement={idx}
//     accumulates notation_info + notation_measures, closes after ready
//   - Builds alphaTab.model.Score directly in JS from the accumulated data,
//     calls score.finish(), then api.renderScore(score)
//   - boundsLookup-driven playback marker (same pattern as tabview slopsmith#734)
//   - alphaSynth player enabled; bridges slopsmith song:play/pause/stop/seek
//     events to alphaTab's transport so the global play button drives the score
//   - Cursor sync: playerPositionChanged (currentTick) when alphaSynth is
//     playing; falls back to bundle.beats → tick lookup otherwise (Scenario 3)
//
// Module-scope singletons:
//   - alphaTab CDN load promise (one <script> per page)
//   - _svFilename — captured from playSong wrap + arrangement:changed
//   - _nextInstanceId — monotonic DOM id suffix

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

const PLUGIN_ID         = 'staffview';
// Pin to the same version as tabview so the CDN script is already cached.
const ALPHATAB_VERSION  = '1.8.2';
const ALPHATAB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@' + ALPHATAB_VERSION + '/dist';

// Notation WS chunk size (matches server.py _NOTATION_CHUNK = 32).
// Used only as a sanity signal — the plugin accumulates until total matches.
const NOTATION_CHUNK = 32;

// Cursor update threshold — skip marker repositioning when the tick
// hasn't advanced by more than this (matches tabview's 30-tick gate).
const TICK_DELTA_THRESHOLD = 30;

// Duration denominator (sloppak) → alphaTab Duration enum value.
// alphaTab Duration: Whole=1 Half=2 Quarter=4 Eighth=8 Sixteenth=16 ThirtySecond=32
const DUR_MAP = { 1: 1, 2: 2, 4: 4, 8: 8, 16: 16, 32: 32 };

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons
// ═══════════════════════════════════════════════════════════════════════

let _svFilename       = null;   // captured from playSong wrap + arrangement:changed
let _nextInstanceId   = 0;
let _atLoadPromise    = null;   // memoized alphaTab CDN script load

// ═══════════════════════════════════════════════════════════════════════
// alphaTab CDN loader
// ═══════════════════════════════════════════════════════════════════════

function _loadAlphaTab() {
    if (window.alphaTab) return Promise.resolve();
    if (_atLoadPromise) return _atLoadPromise;
    _atLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = ALPHATAB_CDN_BASE + '/alphaTab.min.js';
        s.onload  = resolve;
        s.onerror = () => {
            _atLoadPromise = null;  // allow retry
            reject(new Error('[staffview] Failed to load alphaTab from CDN'));
        };
        document.head.appendChild(s);
    });
    return _atLoadPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// Filename tracking (module-level — one global player)
// ═══════════════════════════════════════════════════════════════════════

(function () {
    // Idempotency guards match tabview's pattern: the wrapper is marked
    // on itself; the arrangement listener is gated on a window flag.
    const origPlay = typeof window.playSong === 'function' ? window.playSong : null;
    if (origPlay && !origPlay._staffviewWrapped) {
        const wrapper = async function (filename, arrangement) {
            _svFilename = filename;
            return origPlay.call(this, filename, arrangement);
        };
        wrapper._staffviewWrapped = true;
        window.playSong = wrapper;
    }

    if (
        window.slopsmith &&
        typeof window.slopsmith.on === 'function' &&
        !window.__slopsmithStaffviewArrangementSubscribed
    ) {
        window.slopsmith.on('arrangement:changed', (e) => {
            if (e && e.detail && e.detail.filename) _svFilename = e.detail.filename;
        });
        window.__slopsmithStaffviewArrangementSubscribed = true;
    }
})();

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helpers (mirrors tabview — only panelChromeFor needed)
// ═══════════════════════════════════════════════════════════════════════

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor === 'function';
}

function _resolveMount(canvas) {
    if (_ssActive()) {
        const ss = window.slopsmithSplitscreen;
        return ss.panelChromeFor(canvas);
    }
    return document.getElementById('player');
}

// v3 player chrome (docs/plugin-v3-ui.md): controls injected into the player
// must mount into the stable plugin-control slot instead of the auto-hiding
// transport / footer. Returns null on v2 so callers fall back unchanged.
function _isV3() {
    return !!(window.slopsmith && window.slopsmith.uiVersion === 'v3');
}

function _playerSlot() {
    return (_isV3()
        && window.slopsmith.ui
        && typeof window.slopsmith.ui.playerControlSlot === 'function')
        ? window.slopsmith.ui.playerControlSlot() : null;
}

// ═══════════════════════════════════════════════════════════════════════
// WS URL builder
// ═══════════════════════════════════════════════════════════════════════

function _buildWsUrl(filename, arrIdx) {
    // filename may already be URI-encoded from the data-play attribute;
    // decode first then re-encode cleanly, same as tabview.
    let decoded = filename;
    try { decoded = decodeURIComponent(filename); } catch (_) {}
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws/highway/' + decoded
        + '?arrangement=' + arrIdx;
}

// ═══════════════════════════════════════════════════════════════════════
// Score builder helpers
// ═══════════════════════════════════════════════════════════════════════

// Clef string → alphaTab Clef enum value (verified from AT 1.8.2 source).
// Enum: Neutral=0  C3=1  C4=2  F4=3  G2=4
function _clefValue(clefStr) {
    switch ((clefStr || 'G2').toUpperCase()) {
        case 'F4':      return 3;
        case 'C3':      return 1;
        case 'C4':      return 2;
        case 'NEUTRAL': return 0;
        case 'G2':
        default:        return 4;
    }
}

// Build a duck-typed tempo automation object.
// alphaTab reads .value (BPM), .isVisible, .ratioPosition off tempoAutomations[].
// The internal Automation class is not exported; a plain object works.
function _makeTempoAutomation(bpm) {
    return { type: 0, isLinear: false, ratioPosition: 0, value: bpm, isVisible: true, text: '' };
}

// ═══════════════════════════════════════════════════════════════════════
// Score builder
// ═══════════════════════════════════════════════════════════════════════
// Converts the accumulated notation_info + notation_measures WS data into
// an alphaTab.model.Score and calls score.finish() before returning.
//
// alphaTab model hierarchy:
//   Score
//     masterBars[]        — one per measure (global: ts, tempo)
//     tracks[]            — ONE track for the whole instrument
//       staves[]          — one per sloppak staff (rh, lh, …)
//         bars[]          — one per measure, parallel to masterBars
//           voices[]      — one per voice id found in the sloppak data
//             beats[]
//               notes[]   — note.octave + note.tone from MIDI pitch
//
// Grand staff: all sloppak staves go into a SINGLE alphaTab Track so
// alphaTab renders them with a brace and a shared instrument label.
// Two tracks → two independent bracketed staves (ensemble, not piano).
//
// Note path: MIDI → octave = floor(midi/12), tone = midi % 12.
// Clef enum: Neutral=0 C3=1 C4=2 F4=3 G2=4 (verified from AT 1.8.2 source).

function _buildScore(at, info, measures) {
    const m = at.model;

    const score = new m.Score();
    score.title = '';   // populated from bundle.songInfo in future

    // ── MasterBars ────────────────────────────────────────────────────
    // ts / tempo are omitted-when-unchanged — propagate last-seen value.

    let lastTs    = [4, 4];
    let lastTempo = 120;

    for (let mi = 0; mi < measures.length; mi++) {
        const meas = measures[mi];
        const mb   = new m.MasterBar();
        mb.index   = mi;

        if (meas.ts) { lastTs = meas.ts; }
        mb.timeSignatureNumerator   = lastTs[0];
        mb.timeSignatureDenominator = lastTs[1];

        // Push tempo on the first measure unconditionally (so score.tempo
        // is always readable) and on any measure that changes tempo.
        if (meas.tempo != null) { lastTempo = meas.tempo; }
        if (mi === 0 || meas.tempo != null) {
            mb.tempoAutomations.push(_makeTempoAutomation(lastTempo));
        }

        score.addMasterBar(mb);
    }

    // ── Single Track ──────────────────────────────────────────────────
    // All sloppak staves live in ONE alphaTab Track → grand-staff brace.

    const track     = new m.Track();
    track.index     = 0;
    track.name      = info.instrument
        ? (info.instrument.charAt(0).toUpperCase() + info.instrument.slice(1))
        : 'Piano';
    track.shortName = track.name;

    track.playbackInfo.primaryChannel   = 0;
    track.playbackInfo.secondaryChannel = 1;
    track.playbackInfo.program          = 0;   // Grand Piano
    track.playbackInfo.volume           = 15;
    track.playbackInfo.balance          = 8;

    // ── Staves (one per sloppak staff def) ────────────────────────────
    for (let si = 0; si < info.staves.length; si++) {
        const staffDef = info.staves[si];

        const staff = new m.Staff();
        staff.index  = si;
        staff.track  = track;
        staff.clef   = _clefValue(staffDef.clef);

        staff.showTablature        = false;
        staff.showStandardNotation = true;

        // Collect all distinct voice ids across all measures for this staff.
        const voiceIdSet = new Set();
        for (const meas of measures) {
            const sd = meas.staves && meas.staves[staffDef.id];
            if (!sd) continue;
            for (const v of (sd.voices || [])) voiceIdSet.add(v.v);
        }
        const voiceIds = Array.from(voiceIdSet).sort((a, b) => a - b);
        if (voiceIds.length === 0) voiceIds.push(1);

        // ── Bars (one per measure) ─────────────────────────────────
        for (let mi = 0; mi < measures.length; mi++) {
            const meas = measures[mi];

            const bar  = new m.Bar();
            bar.index  = mi;
            bar.staff  = staff;
            bar.clef   = staff.clef;

            // Per-measure clef override (omitted when unchanged).
            const sd = meas.staves && meas.staves[staffDef.id];
            if (sd && sd.clef) { bar.clef = _clefValue(sd.clef); }

            // voice_id → beat array for this measure/staff.
            const voiceDataMap = {};
            if (sd) {
                for (const v of (sd.voices || [])) {
                    voiceDataMap[v.v] = v.beats || [];
                }
            }

            // ── Voices ────────────────────────────────────────────
            for (let vi = 0; vi < voiceIds.length; vi++) {
                const vid   = voiceIds[vi];
                const voice = new m.Voice();
                voice.index = vi;
                voice.bar   = bar;

                const beatData = voiceDataMap[vid] || [];

                for (const bd of beatData) {
                    const beat    = new m.Beat();
                    beat.voice    = voice;
                    beat.duration = DUR_MAP[bd.dur] !== undefined
                        ? DUR_MAP[bd.dur]
                        : (m.Duration ? m.Duration.Quarter : 4);

                    if (bd.dot === 1) beat.dots = 1;
                    if (bd.dot === 2) beat.dots = 2;
                    // Do NOT set beat.isEmpty for rests. isEmpty=true tells
                    // alphaTab to skip rendering entirely (no glyph at all).
                    // For a rest that should show a rest symbol, leave isEmpty
                    // at its default (false) and simply add no notes — alphaTab
                    // then computes isRest=true via notes.length===0 and renders
                    // the correct rest glyph. (Verified from AT 1.8.2 source:
                    // the renderer gates on `beat.isEmpty` before isRest check.)

                    if (bd.tu && bd.tu.length === 2) {
                        beat.tupletNumerator   = bd.tu[0];
                        beat.tupletDenominator = bd.tu[1];
                    }

                    // Beat-level dynamics.
                    if (bd.dyn) {
                        const DV = m.DynamicValue || {};
                        const dynMap = {
                            ppp: DV.PPP, pp: DV.PP,  p: DV.P,   mp: DV.MP,
                            mf:  DV.MF,  f:  DV.F,   ff: DV.FF, fff: DV.FFF,
                        };
                        if (dynMap[bd.dyn] !== undefined) beat.dynamics = dynMap[bd.dyn];
                    }

                    // Notes (omitted for rests).
                    if (!bd.rest && bd.notes) {
                        for (const nd of bd.notes) {
                            const note = new m.Note();
                            note.beat  = beat;
                            // Piano note path: MIDI → octave + tone.
                            // AT internal: octave = midi/12|0, tone = midi % 12.
                            note.octave = Math.floor(nd.midi / 12);
                            note.tone   = nd.midi % 12;

                            note.isTieDestination = nd.tied === true;
                            if (nd.stc)   note.isStaccato = true;
                            if (nd.ghost) note.isGhost    = true;
                            if (nd.dead)  note.isDead     = true;

                            // Accidental override (sloppak acc field).
                            // AccidentalMode enum (verified from AT 1.8.2 source):
                            // Default=0 ForceNone=1 ForceNatural=2 ForceSharp=3
                            // ForceDoubleSharp=4 ForceFlat=5 ForceDoubleFlat=6
                            if (nd.acc != null) {
                                const accMap = { 0: 2, 1: 3, 2: 4, '-1': 5, '-2': 6 };
                                const am = accMap[String(nd.acc)];
                                if (am !== undefined) note.accidentalMode = am;
                            }

                            beat.addNote(note);
                        }
                    }

                    voice.addBeat(beat);
                }

                // Empty voice → whole rest so the measure isn't blank.
                if (voice.beats.length === 0) {
                    const rest    = new m.Beat();
                    rest.voice    = voice;
                    rest.duration = m.Duration ? m.Duration.Whole : 1;
                    rest.isEmpty  = true;
                    voice.addBeat(rest);
                }

                bar.addVoice(voice);
            }

            staff.addBar(bar);
        }

        track.addStaff(staff);
    }

    score.addTrack(track);

    // finish() wires bidirectional links, resolves ties, computes tick
    // positions and durations — required before renderScore().
    score.finish(new at.Settings());

    // Key signatures: set after finish() because the setter delegates to
    // score.tracks[0].staves[0].bars[i].keySignature.
    let ks = 0;
    for (let mi = 0; mi < measures.length; mi++) {
        if (measures[mi].ks != null) { ks = measures[mi].ks; }
        score.masterBars[mi].keySignature = ks;
    }

    return score;
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (per-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // ── Lifecycle flag ─────────────────────────────────────────────
    let _isReady = false;

    // ── Per-instance DOM/alphaTab state ────────────────────────────
    let _svHighwayCanvas    = null;
    let _svPrevVisibility   = '';
    let _svPrevMountPos     = null;  // saved mount.style.position if we changed it
    let _svContainer        = null;
    let _svAtMount          = null;  // inner div alphaTab renders into
    let _svMarker           = null;  // boundsLookup cursor marker overlay
    let _svErrorBanner      = null;
    let _svErrorBannerTimer = null;
    let _svControlsObserver = null;
    let _svApi              = null;
    let _svApiReady         = false; // renderFinished has fired at least once

    // ── Notation WS state ──────────────────────────────────────────
    let _svWs            = null;   // active WS for notation data
    let _svWsGen         = 0;      // monotonic; callbacks bail if stale
    let _svInfo          = null;   // notation_info payload
    let _svMeasures      = [];     // accumulated notation_measures data
    let _svNotationReady = false;  // all measures received
    let _svRendered      = false;  // renderScore() dispatched for current load

    // ── Load-state tracking (mirrors tabview pattern) ──────────────
    let _svCurrentFile  = null;  // filename of currently-rendered score
    let _svCurrentArr   = null;  // arrangement_index of current score
    let _svLoadingFile  = null;  // in-flight WS target
    let _svLoadingArr   = null;
    let _svFailedFile   = null;  // last permanently-failed (file, arr) pair
    let _svFailedArr    = null;

    // Monotonic token: each new WS connect bumps it; async callbacks
    // capture it and bail when a newer connect has started.
    let _svInitToken    = 0;

    // ── Cursor state ───────────────────────────────────────────────
    // alphaTab's absoluteDisplayStart is 960-ppq ticks, bar 0 beat 0 = 0.
    // staffview builds the score with measure times matching the WS beats
    // stream, so no additional baseline offset is needed (unlike tabview's
    // rs2gp GP5 builder which inserts one beat of silence at the start).
    let _svAtBeats      = [];   // [{beat, start}] sorted by start tick
    let _svLastBeat     = null;
    let _svLastTick     = -1;
    let _svLatestBeats  = null; // bundle.beats snapshot

    // ── alphaSynth player state ────────────────────────────────────
    // _svSoundFontReady: true once soundFontLoaded has fired — api.play()
    // is only valid after this point.
    // _svPlayerTick: last tick received from playerPositionChanged; -1
    // means alphaTab's clock is not driving the cursor (use bundle.beats).
    // _svSongEventHandlers: {play, pause, stop, seek} bound handlers
    // registered on window.slopsmith; removed in _svTeardown.
    let _svSoundFontReady    = false;
    let _svPlayerTick        = -1;   // -1 = alphaSynth not in control
    let _svSongEventHandlers = null;

    // ── Playback mode UI state ─────────────────────────────────────
    // _svPlaybackOn: whether the Playback checkbox is ticked (controls visible).
    // Default false. Resets on each new song (init).
    // _svPillWrap: the wrapper element appended to #player-footer (main)
    // or panelDiv (splitscreen). Removed in _svRemoveContainer().
    // _svPendingPlay: play was requested before soundFontLoaded fired;
    // execute it as soon as the soundfont is ready.
    // _svPlayBtn / _svStopBtn: transport button elements inside the popover;
    // updated by _svUpdatePlayBtn().
    // _svOggPausedByUs: true if we called audio.pause() to make way for
    // alphaSynth — used to decide whether to restore OGG on stop/pause.
    let _svPlaybackOn      = false;
    let _svPillWrap        = null;
    let _svPillRetryTimer  = null;
    let _svPillRetries     = 0;
    const _SV_PILL_MAX_RETRIES = 20;   // ~5 s of 250 ms polls for the v3 slot
    let _svSlotObserver    = null;     // MutationObserver fallback when polls exhaust
    let _svPendingPlay     = false;
    let _svPlayBtn         = null;
    let _svStopBtn         = null;
    let _svOggPausedByUs   = false;
    let _svSynthPlaying    = false;  // intent flag: true = we asked alphaSynth to play

    // ── Window resize ref ──────────────────────────────────────────
    const _onWinResize = () => _svSizeContainer();

    // ── highway.setVisible helper (matches tabview exactly) ────────
    function _svSetHighwayVisible(v) {
        if (v === false && _ssActive()) return;
        try {
            const hw = window.highway;
            if (hw && typeof hw.setVisible === 'function') hw.setVisible(v);
        } catch (_) { /* best-effort */ }
    }

    // ── Container creation ─────────────────────────────────────────

    function _svCreateContainer() {
        if (_svContainer) return _svContainer;
        const mount = _resolveMount(_svHighwayCanvas);
        if (!mount) return null;

        if (getComputedStyle(mount).position === 'static') {
            _svPrevMountPos = mount.style.position;
            mount.style.position = 'relative';
        }

        const c = document.createElement('div');
        c.id = 'staffview-container-' + _instanceId;
        c.dataset.staffviewInstance = String(_instanceId);
        // visibility:hidden so alphaTab can measure width for layout.
        // Swapped to '' in renderFinished (painted-to-painted handoff).
        c.style.cssText = [
            'visibility:hidden',
            'position:absolute',
            'top:0',
            'left:0',
            'right:0',
            'overflow-y:auto',
            'background:#fff',     // white — alphaTab renders black ink on its own
                                   // SVG surfaces; the container color shows through
            'z-index:5',
        ].join(';');

        const inner = document.createElement('div');
        inner.id = 'staffview-at-' + _instanceId;
        c.appendChild(inner);

        // Playback marker — boundsLookup-driven (slopsmith#734 pattern).
        const marker = document.createElement('div');
        marker.id = 'staffview-marker-' + _instanceId;
        marker.style.cssText = [
            'position:absolute',
            'left:0',
            'top:0',
            'width:0',
            'height:0',
            'background:rgba(64,128,224,0.18)',
            'border-left:2px solid rgba(64,128,224,0.95)',
            'box-shadow:0 0 8px rgba(64,128,224,0.55)',
            'pointer-events:none',
            'z-index:999',
            'display:none',
        ].join(';');
        c.appendChild(marker);

        mount.appendChild(c);
        _svContainer = c;
        _svAtMount   = inner;
        _svMarker    = marker;

        // ── Click-to-seek ─────────────────────────────────────────
        // mousedown on the score div: resolve the clicked position to a
        // beat tick via boundsLookup.getBeatAtPos(), then seek both
        // alphaSynth (tickPosition) and the OGG audio element (currentTime).
        inner.addEventListener('mousedown', (e) => {
            if (!_svApi || !_svApiReady) return;
            const bl = _svApi.boundsLookup;
            if (!bl || typeof bl.getBeatAtPos !== 'function') return;

            // Coords relative to the alphaTab inner div (alphaTab uses its
            // own coordinate space rooted at the render surface origin).
            const rect = inner.getBoundingClientRect();
            const x    = e.clientX - rect.left  + inner.scrollLeft;
            const y    = e.clientY - rect.top   + inner.scrollTop;

            let beat;
            try { beat = bl.getBeatAtPos(x, y); } catch (_) { return; }
            if (!beat) return;

            const tick = typeof beat.absoluteDisplayStart === 'number'
                ? beat.absoluteDisplayStart
                : (typeof beat.absolutePlaybackStart === 'number'
                    ? beat.absolutePlaybackStart : null);
            if (tick === null) return;

            // Update our cursor immediately.
            _svLastTick = tick;
            _svLastBeat = beat;
            _svUpdateMarker();

            if (_svPlaybackOn && _svApi && _svSoundFontReady) {
                // Seek alphaSynth.
                try { _svApi.tickPosition = tick; } catch (_) {}
            } else {
                // Seek the OGG audio element using the bundle.beats map.
                // Convert tick back to seconds: secs = tick / (BPM/60 * 960).
                // Use the score tempo as approximation.
                try {
                    const score = _svApi && _svApi.score;
                    const bpm   = (score && score.tempo) ? score.tempo : 120;
                    const secs  = tick / ((bpm / 60) * 960);
                    const audio = document.getElementById('audio');
                    if (audio) audio.currentTime = secs;
                } catch (_) {}
            }
        });

        // ResizeObserver on controls bar so bottom inset stays correct
        // when the bar wraps to a second row (main-player only).
        if (!_ssActive() && typeof ResizeObserver !== 'undefined') {
            const controls = document.getElementById('player-controls');
            if (controls) {
                _svControlsObserver = new ResizeObserver(() => _svSizeContainer());
                _svControlsObserver.observe(controls);
            }
        }

        _svCreatePill();

        return c;
    }

    function _svSizeContainer() {
        if (!_svContainer) return;
        const mount = _resolveMount(_svHighwayCanvas);
        if (!mount) return;
        let topInset = 0, bottomInset = 0;
        if (!_ssActive()) {
            const hud      = document.getElementById('player-hud');
            const controls = document.getElementById('player-controls');
            if (_isV3()) {
                // v3 chrome (#player-hud, #player-controls) uses position:absolute
                // overlays — the elements are in the DOM with non-zero offsetHeight
                // but they do NOT consume layout space. Subtracting their heights
                // would create permanent blank bands at the top and bottom of the
                // staff view. Force both insets to 0 in v3.
                topInset    = 0;
                bottomInset = 0;
            } else {
                topInset    = (hud      && hud.offsetHeight)      || 60;
                bottomInset = (controls && controls.offsetHeight) || 48;
            }
        }
        _svContainer.style.top    = topInset + 'px';
        _svContainer.style.height = Math.max(0, mount.clientHeight - topInset - bottomInset) + 'px';
        _svUpdateMarker();
    }

    function _svRemoveContainer() {
        if (_svControlsObserver) {
            try { _svControlsObserver.disconnect(); } catch (_) {}
            _svControlsObserver = null;
        }
        _svRemovePill();
        if (_svContainer) {
            if (_svPrevMountPos !== null) {
                const mount = _svContainer.parentElement;
                if (mount) mount.style.position = _svPrevMountPos;
                _svPrevMountPos = null;
            }
            _svContainer.remove();
            _svContainer = null;
            _svAtMount   = null;
            _svMarker    = null;
        }
    }

    // ── Playback mode pill ─────────────────────────────────────────
    // A small pill button + popover injected into #player-footer (main
    // player) or the splitscreen panelDiv (splitscreen), letting the user
    // switch between OGG audio (default) and alphaSynth playback.
    //
    // Own CSS class names (sv-pill, sv-pill--active, sv-popover) are used
    // instead of section-practice-pill to avoid semantic confusion and
    // future coexistence issues with the practice pill.
    //
    // Pill anchor:
    //   Main player  → document.getElementById('player-footer')
    //   Splitscreen  → _resolveMount (the panelDiv, position:relative)
    //                  pill wrapper gets position:absolute; bottom:0; left:8px
    //                  so it sits at panel bottom-left alongside the bar toggle

    function _svCreatePill() {
        if (_svPillWrap) return;

        const inSS     = _ssActive();
        // v3: mount into the stable plugin-control slot (the "Plugins" rail
        // popover) — #player-footer belongs to the v2 chrome and the v3
        // transport auto-hides (docs/plugin-v3-ui.md). v2 path unchanged.
        const slot     = inSS ? null : _playerSlot();
        // v3: never fall back to #player-footer — that element belongs to the
        // v2 chrome and auto-hides in v3. If the slot isn't ready yet the
        // retry path below will keep trying. v2 falls back normally.
        const footer   = inSS ? _resolveMount(_svHighwayCanvas)
                              : (_isV3() ? slot : (slot || document.getElementById('player-footer')));
        if (!footer) {
            // v3 mounts the pill into the plugin-control slot, which the rail
            // popover may not have created yet on the first call. Without a
            // retry the pill would be permanently missing for the session.
            // Fast path: poll a bounded number of times (covers the common
            // case where the v3 slot appears within a few seconds of startup).
            // Fallback: if polls exhaust (slot lazily created, e.g. after user
            // first opens the plugin rail), arm a MutationObserver on
            // document.body that fires _svCreatePill exactly once when the
            // slot element arrives in the DOM. Splitscreen and v2 have no
            // late-slot problem so they fall through to the single attempt.
            if (!inSS && _isV3()) {
                if (_svPillRetries < _SV_PILL_MAX_RETRIES) {
                    _svPillRetries += 1;
                    _svPillRetryTimer = setTimeout(_svCreatePill, 250);
                } else if (!_svSlotObserver) {
                    _svSlotObserver = new MutationObserver(function () {
                        if (_svPillWrap || !_playerSlot()) return;
                        _svSlotObserver.disconnect();
                        _svSlotObserver = null;
                        _svCreatePill();
                    });
                    _svSlotObserver.observe(document.body, { childList: true, subtree: true });
                }
            }
            return;
        }
        if (_svPillRetryTimer) { clearTimeout(_svPillRetryTimer); _svPillRetryTimer = null; }
        if (_svSlotObserver)   { _svSlotObserver.disconnect(); _svSlotObserver = null; }

        // ── Wrapper (position:relative — popover anchors off it) ──
        // In splitscreen the wrapper is absolute so it can sit at the
        // bottom-left of the panelDiv without disturbing panel layout.
        const wrap = document.createElement('div');
        wrap.id = 'sv-pill-wrap-' + _instanceId;
        if (inSS) {
            wrap.style.cssText = [
                'position:absolute',
                'bottom:0',
                'left:8px',
                'z-index:7',
                'display:inline-flex',
                'align-items:center',
                'padding:4px 8px',
            ].join(';');
        } else {
            wrap.style.cssText = [
                'position:relative',
                'display:inline-flex',
                'align-items:center',
                'padding:4px 8px',
            ].join(';');
        }

        // ── Pill button ───────────────────────────────────────────
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.id   = 'sv-pill-' + _instanceId;
        pill.setAttribute('aria-haspopup', 'dialog');
        pill.setAttribute('aria-expanded', 'false');
        pill.setAttribute('aria-label', 'Staffview options');
        pill.title = 'Staffview';
        pill.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'gap:5px',
            'padding:4px 10px',
            'border-radius:9999px',
            'font-size:12px',
            'font-weight:600',
            'color:#cbd5e1',
            'background:#1e2030',
            'border:1px solid rgba(255,255,255,0.15)',
            'cursor:pointer',
            'transition:background 0.15s,border-color 0.15s,color 0.15s',
            'white-space:nowrap',
            'font-family:inherit',
        ].join(';');
        pill.innerHTML = '<span aria-hidden="true" style="font-size:13px;line-height:1">♩</span>'
                       + '<span>Staffview</span>'
                       + '<span aria-hidden="true" style="font-size:10px;opacity:0.8">▾</span>';

        // ── Popover ───────────────────────────────────────────────
        const popover = document.createElement('div');
        popover.id    = 'sv-popover-' + _instanceId;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', 'Staffview options');
        popover.style.cssText = [
            'display:none',
            'position:absolute',
            'left:0',
            'bottom:calc(100% + 6px)',
            inSS ? 'z-index:10' : 'z-index:60',
            'width:max-content',
            'max-width:min(320px,calc(100vw - 32px))',
            'padding:10px 14px',
            'border-radius:12px',
            'border:1px solid rgba(255,255,255,0.12)',
            'background:rgba(12,12,22,0.98)',
            'box-shadow:0 12px 30px rgba(0,0,0,0.5)',
            'font-family:system-ui,sans-serif',
            'font-size:12px',
            'color:#cbd5e1',
            'pointer-events:auto',
        ].join(';');

        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-weight:700;font-size:11px;letter-spacing:0.06em;'
                          + 'text-transform:uppercase;color:#6b7280;margin-bottom:8px';
        hdr.textContent = '♩ Staffview';
        popover.appendChild(hdr);

        // ── Controls row: [checkbox] Playback  [⏮] [▶/⏸] [⏹] ────
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px';

        // Checkbox
        const cb = document.createElement('input');
        cb.type    = 'checkbox';
        cb.id      = 'sv-cb-playback-' + _instanceId;
        cb.checked = _svPlaybackOn;
        cb.style.cssText = 'accent-color:#4080e0;cursor:pointer;flex-shrink:0';
        cb.addEventListener('change', () => {
            _svSetPlaybackMode(cb.checked, _svInitToken);
        });

        const cbLabel = document.createElement('label');
        cbLabel.htmlFor = cb.id;
        cbLabel.style.cssText = 'font-size:12px;font-weight:600;letter-spacing:0.02em;'
                              + 'color:#9ca3af;cursor:pointer;user-select:none;flex-shrink:0';
        cbLabel.textContent = 'Playback';

        // Transport buttons (hidden until checkbox is ticked)
        function _mkBtn(symbol, title) {
            const b = document.createElement('button');
            b.type = 'button';
            b.title = title;
            b.dataset.svTransport = '1';
            b.textContent = symbol;
            b.style.cssText = [
                'display:none',            // shown when _svPlaybackOn
                'align-items:center',
                'justify-content:center',
                'width:26px',
                'height:26px',
                'padding:0',
                'border-radius:6px',
                'font-size:13px',
                'line-height:1',
                'color:#cbd5e1',
                'background:#2a2d40',
                'border:1px solid rgba(255,255,255,0.12)',
                'cursor:pointer',
                'font-family:inherit',
                'flex-shrink:0',
            ].join(';');
            b.addEventListener('mouseenter', () => { b.style.background = '#373b55'; });
            b.addEventListener('mouseleave', () => { b.style.background = '#2a2d40'; });
            return b;
        }

        const rewindBtn = _mkBtn('⏮', 'Rewind to start');
        const playBtn   = _mkBtn('▶', 'Play');
        const stopBtn   = _mkBtn('⏹', 'Stop');

        rewindBtn.addEventListener('click', () => {
            if (!_svApi || !_svSoundFontReady) return;
            try { _svApi.tickPosition = 0; } catch (_) {}
        });
        playBtn.addEventListener('click', () => {
            // Toggle play/pause based on intent flag, not _svPlayerTick.
            if (!_svApi || !_svSoundFontReady) { _svPendingPlay = true; return; }
            if (_svSynthPlaying) {
                _svSynthPause();
            } else {
                _svSynthPlay();
            }
        });
        stopBtn.addEventListener('click', () => {
            _svSynthStop();
        });

        // Store refs for _svUpdatePlayBtn() and _svSetPlaybackMode()
        _svPlayBtn = playBtn;
        _svStopBtn = stopBtn;

        row.appendChild(cb);
        row.appendChild(cbLabel);
        row.appendChild(rewindBtn);
        row.appendChild(playBtn);
        row.appendChild(stopBtn);
        popover.appendChild(row);

        // Show transport buttons if checkbox starts checked (shouldn't happen
        // normally — playback resets on each song — but guard anyway).
        if (_svPlaybackOn) {
            [rewindBtn, playBtn, stopBtn].forEach(b => { b.style.display = 'inline-flex'; });
        }

        // ── Toggle popover on pill click ──────────────────────────
        let _closeOnOutside = null;
        pill.addEventListener('click', () => {
            const open = popover.style.display !== 'none';
            if (open) {
                popover.style.display = 'none';
                pill.setAttribute('aria-expanded', 'false');
                if (_closeOnOutside) {
                    document.removeEventListener('mousedown', _closeOnOutside, true);
                    _closeOnOutside = null;
                }
            } else {
                popover.style.display = 'block';
                pill.setAttribute('aria-expanded', 'true');
                _closeOnOutside = (e) => {
                    if (!wrap.contains(e.target)) {
                        popover.style.display = 'none';
                        pill.setAttribute('aria-expanded', 'false');
                        document.removeEventListener('mousedown', _closeOnOutside, true);
                        _closeOnOutside = null;
                    }
                };
                // Defer one tick so the triggering click doesn't immediately close.
                setTimeout(() => {
                    document.addEventListener('mousedown', _closeOnOutside, true);
                }, 0);
            }
        });

        wrap.appendChild(popover);
        wrap.appendChild(pill);
        if (slot) {
            // v3 slot: plain append — the legacy prepend anchor reasoning
            // below applies only to the v2 footer.
            footer.appendChild(wrap);
        } else {
            // Prepend so the pill appears above #player-controls in the footer,
            // not below it. insertBefore with firstChild works even when the
            // footer is empty (firstChild is null → equivalent to appendChild).
            footer.insertBefore(wrap, footer.firstChild);
        }
        _svPillWrap = wrap;
    }

    function _svRemovePill() {
        if (_svPillRetryTimer) { clearTimeout(_svPillRetryTimer); _svPillRetryTimer = null; }
        if (_svSlotObserver)   { _svSlotObserver.disconnect(); _svSlotObserver = null; }
        _svPillRetries = 0;
        if (_svPillWrap) {
            _svPillWrap.remove();
            _svPillWrap = null;
        }
        _svPlayBtn     = null;
        _svStopBtn     = null;
        _svPlaybackOn  = false;
        _svPendingPlay = false;
    }

    // Show/hide the transport buttons when the Playback checkbox is toggled.
    // Does NOT start alphaSynth — the user must hit ▶.
    // When unchecked: stops alphaSynth and restores OGG if we paused it.
    function _svSetPlaybackMode(on, myToken) {
        if (_svInitToken !== myToken) return;
        _svPlaybackOn = on;

        // Show or hide transport buttons (rewind, play, stop).
        if (_svPillWrap) {
            const btns = _svPillWrap.querySelectorAll('[data-sv-transport]');
            btns.forEach(b => {
                b.style.display = on ? 'inline-flex' : 'none';
            });
        }

        // Update pill active indicator.
        const pill = _svPillWrap && _svPillWrap.querySelector('#sv-pill-' + _instanceId);
        if (pill) {
            if (on) {
                pill.style.background   = 'rgba(64,128,224,0.2)';
                pill.style.borderColor  = '#4080e0';
                pill.style.color        = '#1e2030';
            } else {
                pill.style.background   = '#1e2030';
                pill.style.borderColor  = 'rgba(255,255,255,0.15)';
                pill.style.color        = '#cbd5e1';
            }
        }

        if (!on) {
            // Checkbox unticked — stop alphaSynth and restore OGG.
            _svSynthStop();
        }
    }

    // ── Error banner ───────────────────────────────────────────────

    function _svShowErrorBanner(message) {
        _svRemoveErrorBanner();
        const mount = _resolveMount(_svHighwayCanvas);
        if (!mount) return;
        const banner = document.createElement('div');
        banner.id = 'staffview-error-banner-' + _instanceId;
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:absolute',
            'top:10px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(220,80,80,0.94)',
            'color:#fff',
            'padding:8px 16px',
            'border-radius:8px',
            'z-index:30',
            'font-size:12px',
            'font-family:system-ui,sans-serif',
            'max-width:80%',
            'box-shadow:0 2px 8px rgba(0,0,0,0.3)',
            'pointer-events:none',
        ].join(';');
        banner.textContent = 'Staff View: ' + (message || 'failed to load');
        mount.appendChild(banner);
        _svErrorBanner = banner;
        _svErrorBannerTimer = setTimeout(_svRemoveErrorBanner, 6000);
    }

    function _svRemoveErrorBanner() {
        if (_svErrorBanner) { _svErrorBanner.remove(); _svErrorBanner = null; }
        if (_svErrorBannerTimer) { clearTimeout(_svErrorBannerTimer); _svErrorBannerTimer = null; }
    }

    // ── Notation WS ────────────────────────────────────────────────
    // Opens a second WS connection to the highway endpoint for this
    // instance. Only processes notation_info and notation_measures;
    // closes the connection after the server sends ready (all other
    // messages are already handled by the main highway WS).

    function _svOpenWs(filename, arrIdx, myToken) {
        _svCloseWs();
        if (!filename) return;

        _svWsGen++;
        const gen = _svWsGen;
        const url = _buildWsUrl(filename, arrIdx);
        let ws;
        try { ws = new WebSocket(url); } catch (e) {
            console.error('[staffview] WS open failed:', e);
            _svHandleLoadError('WebSocket failed to open', myToken);
            return;
        }
        _svWs = ws;

        ws.onmessage = (ev) => {
            if (gen !== _svWsGen || _svInitToken !== myToken) return;
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { return; }

            switch (msg.type) {
                case 'notation_info':
                    _svInfo     = msg;
                    _svMeasures = [];
                    _svNotationReady = false;
                    _svRendered      = false;
                    break;

                case 'notation_measures':
                    if (!_svInfo) break;                // no header yet — skip
                    _svMeasures.push(...(msg.data || []));
                    if (_svMeasures.length >= msg.total) {
                        _svNotationReady = true;
                        // Close WS early — we have all the notation data we need.
                        // The main highway WS continues to drive the player normally.
                        _svCloseWs();
                        _svTryRender(myToken);
                    }
                    break;

                case 'ready':
                    // Server sent ready before all notation_measures arrived
                    // (or there was no notation for this arrangement).
                    // If we've already got everything, render. If notation
                    // was never announced (has_notation false), nothing to do.
                    if (_svNotationReady) {
                        _svCloseWs();
                        _svTryRender(myToken);
                    } else if (!_svInfo) {
                        // This arrangement carries no notation — stay quiet.
                        _svCloseWs();
                    }
                    break;

                case 'song_info':
                    // has_notation=false means no data will follow for this
                    // arrangement — close early.
                    if (msg.has_notation === false) {
                        _svCloseWs();
                    }
                    break;

                default:
                    break;
            }
        };

        ws.onerror = () => {
            if (gen !== _svWsGen || _svInitToken !== myToken) return;
            _svHandleLoadError('WS error', myToken);
        };

        ws.onclose = () => {
            if (_svWs === ws) _svWs = null;
        };
    }

    function _svCloseWs() {
        if (_svWs) {
            try { _svWs.close(); } catch (_) {}
            _svWs = null;
        }
    }

    // ── alphaSynth transport helpers ───────────────────────────────
    // These are the single entry points for play/pause/stop. They manage
    // OGG/alphaSynth mutual exclusion and keep the button icon in sync.
    //
    // Rule: if one source is playing, the other pauses.
    //   _svSynthPlay()  → pause OGG (if playing), start alphaSynth
    //   _svSynthPause() → pause alphaSynth, restore OGG (if we paused it)
    //   _svSynthStop()  → stop alphaSynth (tick 0), restore OGG if needed
    //
    // _svOggPausedByUs tracks whether WE called audio.pause() so we only
    // restore it if we were the ones who stopped it.

    function _svUpdatePlayBtn() {
        if (!_svPlayBtn) return;
        _svPlayBtn.textContent = _svSynthPlaying ? '⏸' : '▶';
        _svPlayBtn.title       = _svSynthPlaying ? 'Pause' : 'Play';
    }

    function _svSynthPlay() {
        if (!_svApi) return;
        // Pause OGG if it is currently playing.
        const audio = document.getElementById('audio');
        if (audio && !audio.paused) {
            audio.pause();
            _svOggPausedByUs = true;
        }
        // Install the bridge so that if the user later hits the slopsmith
        // play button, alphaSynth yields back to OGG.
        _svInstallSongBridge(_svInitToken);
        // Start alphaSynth.
        if (_svSoundFontReady) {
            try { _svApi.play(); } catch (_) {}
        } else {
            _svPendingPlay = true;
        }
        _svSynthPlaying = true;
        _svUpdatePlayBtn();
    }

    function _svSynthPause() {
        if (!_svApi) return;
        _svPendingPlay  = false;
        _svSynthPlaying = false;
        try { _svApi.pause(); } catch (_) {}
        _svPlayerTick = -1;
        _svUpdatePlayBtn();
        // Restore OGG if we paused it.
        if (_svOggPausedByUs) {
            _svOggPausedByUs = false;
            const audio = document.getElementById('audio');
            if (audio) { try { audio.play(); } catch (_) {} }
        }
    }

    function _svSynthStop() {
        _svPendingPlay  = false;
        _svSynthPlaying = false;
        if (_svApi) { try { _svApi.stop(); } catch (_) {} }
        _svPlayerTick = -1;
        _svLastTick   = -1;
        _svLastBeat   = null;
        _svUpdateMarker();
        _svUpdatePlayBtn();
        _svRemoveSongBridge();
        // Restore OGG if we paused it.
        if (_svOggPausedByUs) {
            _svOggPausedByUs = false;
            const audio = document.getElementById('audio');
            if (audio) { try { audio.play(); } catch (_) {} }
        }
    }

    // ── alphaSynth transport bridge ────────────────────────────────
    // Installed only while alphaSynth is playing (i.e. after the user
    // hits ▶ in the popover). Listens for two events:
    //
    //   OGG 'play'   → the user hit the slopsmith play button while
    //                  alphaSynth was running; yield — pause alphaSynth
    //                  and let OGG take over.
    //   song:stop    → song switch / teardown; stop alphaSynth entirely.
    //
    // No seek guard, no end guard, no 'pause' mirror — we are not
    // syncing alphaSynth to OGG transport anymore.

    function _svInstallSongBridge(myToken) {
        _svRemoveSongBridge();

        const audio = document.getElementById('audio');
        if (!audio) return;

        // OGG started playing → alphaSynth yields.
        const onAudioPlay = () => {
            if (_svInitToken !== myToken || !_svApi) return;
            // OGG took over — pause alphaSynth (do NOT restore OGG here;
            // OGG is already playing, that's what triggered this).
            _svPendingPlay   = false;
            _svSynthPlaying  = false;
            try { _svApi.pause(); } catch (_) {}
            _svPlayerTick    = -1;
            _svOggPausedByUs = false;
            _svUpdatePlayBtn();
            _svRemoveSongBridge();
        };

        // song:stop — song switch / Close.
        const onStop = () => {
            if (_svInitToken !== myToken) return;
            _svOggPausedByUs = false;  // OGG is stopping anyway
            _svSynthStop();
        };

        audio.addEventListener('play', onAudioPlay);
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('song:stop', onStop);
        }

        _svSongEventHandlers = { onAudioPlay, onStop, audio };
    }

    function _svRemoveSongBridge() {
        if (!_svSongEventHandlers) return;
        const h = _svSongEventHandlers;
        if (h.audio) {
            h.audio.removeEventListener('play', h.onAudioPlay);
        }
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            window.slopsmith.off('song:stop', h.onStop);
        }
        _svSongEventHandlers = null;
    }

    // ── alphaTab init ──────────────────────────────────────────────

    async function _svInitAlphaTab(myToken) {
        const c = _svCreateContainer();
        if (!c) return;

        if (_svApi) {
            try { _svApi.stop(); } catch (_) {}
            try { _svApi.destroy(); } catch (_) {}
            _svApi = null;
        }
        _svApiReady       = false;
        _svSoundFontReady = false;
        _svPlayerTick     = -1;
        _svAtBeats        = [];
        _svLastBeat       = null;
        if (_svAtMount) _svAtMount.innerHTML = '';

        await _loadAlphaTab();
        if (_svInitToken !== myToken) return;

        _svApi = new alphaTab.AlphaTabApi(_svAtMount, {
            core: {
                fontDirectory:     ALPHATAB_CDN_BASE + '/font/',
                includeNoteBounds: true,   // needed for boundsLookup marker
            },
            display: {
                layoutMode:   alphaTab.LayoutMode.Page,
                scale:        0.9,
                staveProfile: alphaTab.StaveProfile
                    ? alphaTab.StaveProfile.Score
                    : 2,   // Score-only: no tablature staff
            },
            player: {
                enablePlayer: true,
                enableCursor: false,   // we draw our own marker
                soundFont:    ALPHATAB_CDN_BASE + '/soundfont/sonivox.sf2',
            },
        });

        // ── Score loaded ─────────────────────────────────────────
        _svApi.scoreLoaded.on((score) => {
            if (_svInitToken !== myToken) return;
            _svAtBeats    = _svBuildBeatTimeline(score);
            _svLastBeat   = null;
            _svPlayerTick = -1;
        });

        // ── Sound font ready ──────────────────────────────────────
        // api.play() must not be called before soundFontLoaded fires.
        // If a play request arrived while loading, execute it now.
        _svApi.soundFontLoaded.on(() => {
            if (_svInitToken !== myToken) return;
            _svSoundFontReady = true;
            if (_svPendingPlay && _svPlaybackOn) {
                _svPendingPlay = false;
                try { _svApi.play(); } catch (_) {}
            }
        });

        // ── Player position → cursor ──────────────────────────────
        // playerPositionChanged fires every ~50 ms while alphaSynth plays.
        // args: { currentTick, currentTime, endTick, endTime, isSeek, ... }
        // When alphaSynth is driving, use currentTick directly; skip the
        // bundle.beats lookup (that path is for Scenario 3 only).
        _svApi.playerPositionChanged.on((args) => {
            if (_svInitToken !== myToken || !_svApiReady) return;
            const tick = args && typeof args.currentTick === 'number'
                ? args.currentTick : -1;
            if (tick < 0) return;
            _svPlayerTick = tick;
            if (Math.abs(tick - _svLastTick) <= TICK_DELTA_THRESHOLD) return;
            _svLastTick = tick;
            _svLastBeat = _svFindBeatAtTick(tick);
            _svUpdateMarker();
        });

        // ── Player finished ───────────────────────────────────────
        // AlphaSynth already calls its own stop() internally before
        // firing finished — state is Paused at tick 0 by the time this
        // handler runs. Reset cursor/intent state and the button to ▶.
        // Do NOT restore OGG here — audio.play() would restart it from
        // the beginning, and the resulting 'play' event would fire the
        // bridge and immediately kill the next alphaSynth play() call.
        // OGG is restored only on explicit user action (pause/stop btn)
        // or teardown. Do NOT call api.stop() — already stopped.
        _svApi.playerFinished.on(() => {
            if (_svInitToken !== myToken) return;
            _svPendingPlay  = false;
            _svSynthPlaying = false;
            _svPlayerTick   = -1;
            _svLastBeat     = null;
            _svUpdateMarker();
            _svUpdatePlayBtn();
            _svRemoveSongBridge();
            _svOggPausedByUs = false;
        });

        // ── Render finished → reveal container ────────────────────
        _svApi.renderFinished.on(() => {
            if (_svInitToken !== myToken) return;
            _svApiReady = true;

            // Painted-to-painted handoff: reveal our container, hide the
            // highway canvas (visibility:hidden, not display:none — lets
            // alphaTab keep measuring width on subsequent layouts).
            if (_svContainer) _svContainer.style.visibility = '';
            if (_svHighwayCanvas) _svHighwayCanvas.style.visibility = 'hidden';
            _svSetHighwayVisible(false);

            _svFailedFile = null;
            _svFailedArr  = null;
            _svRemoveErrorBanner();

            // Re-place marker after each layout (boundsLookup is freshly valid).
            _svUpdateMarker();
        });

        // ── alphaTab error ────────────────────────────────────────
        _svApi.error.on((e) => {
            if (_svInitToken !== myToken) return;
            console.error('[staffview] alphaTab error:', e);
            const failedFile = _svCurrentFile || _svLoadingFile;
            const failedArr  = _svCurrentArr  != null ? _svCurrentArr : _svLoadingArr;
            _svApiReady       = false;
            _svSoundFontReady = false;
            _svCurrentFile    = null;
            _svCurrentArr     = null;
            if (failedFile != null) { _svFailedFile = failedFile; _svFailedArr = failedArr; }
            if (_svContainer) _svContainer.style.visibility = 'hidden';
            if (_svHighwayCanvas) _svHighwayCanvas.style.visibility = _svPrevVisibility || '';
            _svSetHighwayVisible(null);
            const msg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'render failed');
            _svShowErrorBanner(msg);
        });
    }

    // ── Render trigger ─────────────────────────────────────────────

    async function _svTryRender(myToken) {
        if (_svRendered || !_svNotationReady || !_svInfo || _svMeasures.length === 0) return;
        if (_svInitToken !== myToken) return;
        _svRendered = true;

        const container = _svCreateContainer();
        if (!container) {
            _svHandleLoadError('mount unavailable at render time', myToken);
            return;
        }

        _svSizeContainer();

        try {
            await _svInitAlphaTab(myToken);
            if (_svInitToken !== myToken || !_svApi) return;

            const at    = window.alphaTab;
            const score = _buildScore(at, _svInfo, _svMeasures);
            // Single track — pass [0] explicitly; omitting trackIndexes
            // causes alphaTab to render only the first track anyway, but
            // being explicit avoids any version-dependent default behaviour.
            _svApi.renderScore(score, [0]);

            _svCurrentFile = _svLoadingFile;
            _svCurrentArr  = _svLoadingArr;
            // DO NOT show the container here — renderFinished handles the
            // visibility swap once alphaTab has actually painted output.
            // The alphaSynth bridge is installed only when the user enables
            // Playback mode via the pill — not unconditionally here.
        } catch (e) {
            if (_svInitToken !== myToken) return;
            console.error('[staffview] score build / render failed:', e);
            _svHandleLoadError((e && e.message) ? e.message : String(e), myToken);
        }
    }

    // ── Full WS + render pipeline ──────────────────────────────────

    function _svConnectAndLoad(filename, arrIdx, myToken) {
        if (!filename) {
            console.warn('[staffview] no filename — skipping');
            return;
        }
        if (!_resolveMount(_svHighwayCanvas)) return;

        _svLoadingFile   = filename;
        _svLoadingArr    = arrIdx;
        _svInfo          = null;
        _svMeasures      = [];
        _svNotationReady = false;
        _svRendered      = false;

        _svOpenWs(filename, arrIdx, myToken);
    }

    function _svHandleLoadError(message, myToken) {
        if (_svInitToken !== myToken) return;
        _svFailedFile = _svLoadingFile;
        _svFailedArr  = _svLoadingArr;
        if (_svContainer) _svContainer.style.visibility = 'hidden';
        if (_svHighwayCanvas) _svHighwayCanvas.style.visibility = _svPrevVisibility || '';
        _svSetHighwayVisible(null);
        _svShowErrorBanner(message || 'failed to load');
        _svLoadingFile = null;
        _svLoadingArr  = null;
    }

    // ── Beat timeline (tick → Beat lookup) ────────────────────────
    // Walks score.tracks[0].staves[0] only — the first staff of the
    // first track is sufficient to build the absolute-tick index used
    // for cursor sync.

    function _svBuildBeatTimeline(score) {
        const out = [];
        try {
            trackLoop: for (const track of (score.tracks || [])) {
                for (const staff of (track.staves || [])) {
                    for (const bar of (staff.bars || [])) {
                        for (const voice of (bar.voices || [])) {
                            for (const beat of (voice.beats || [])) {
                                const start = typeof beat.absoluteDisplayStart === 'number'
                                    ? beat.absoluteDisplayStart
                                    : beat.absolutePlaybackStart;
                                if (typeof start === 'number') {
                                    out.push({ beat, start });
                                }
                            }
                        }
                    }
                    break trackLoop; // first staff per track is sufficient; also exits trackLoop
                }
            }
        } catch (_) {}
        out.sort((a, b) => a.start - b.start);
        return out;
    }

    function _svFindBeatAtTick(tick) {
        const arr = _svAtBeats;
        if (!arr.length) return null;
        if (tick < arr[0].start) return arr[0].beat;
        let lo = 0, hi = arr.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].start <= tick) { ans = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return arr[ans].beat;
    }

    // ── Cursor sync ────────────────────────────────────────────────
    // Scenario 3 path: maps bundle.currentTime → MIDI ticks via the
    // bundle.beats stream. Skipped when alphaSynth is driving the cursor
    // via playerPositionChanged (_svPlayerTick >= 0).

    function _svSyncCursor(currentTime) {
        // When alphaSynth is playing, playerPositionChanged owns the cursor.
        if (_svPlayerTick >= 0) return;

        if (!_svApi || !_svApiReady || !_svLatestBeats) return;

        const beats = _svLatestBeats;
        if (beats.length < 2) return;

        // Binary search: largest i where beats[i].time <= currentTime.
        if (currentTime < beats[0].time) return;
        let lo = 0, hi = beats.length - 2, idx = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (beats[mid].time <= currentTime) { idx = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }

        // Fractional interpolation within the beat interval.
        let frac = 0;
        if (idx < beats.length - 1) {
            const bStart = beats[idx].time;
            const bEnd   = beats[idx + 1].time;
            if (bEnd > bStart) {
                frac = Math.min(1, Math.max(0, (currentTime - bStart) / (bEnd - bStart)));
            }
        }

        // 960 ticks per beat (alphaTab standard PPQN).
        const tick = Math.round((idx + frac) * 960);

        if (Math.abs(tick - _svLastTick) <= TICK_DELTA_THRESHOLD) return;
        _svLastTick = tick;
        _svLastBeat = _svFindBeatAtTick(tick);
        _svUpdateMarker();
    }

    // ── Playback marker (boundsLookup-driven, slopsmith#734) ────────
    // Uses boundsLookup.staffSystems to span the full system height
    // (all staves in the row), then pins the x/w from the beat bounds.
    // This gives a full-height column cursor across treble + bass staves.

    function _svUpdateMarker() {
        if (!_svMarker || !_svContainer || !_svAtMount) return;
        if (!_svLastBeat) { _svMarker.style.display = 'none'; return; }

        const bl  = _svApi && _svApi.boundsLookup;
        if (!bl)  { _svMarker.style.display = 'none'; return; }

        // Get the beat's own bounds for x position and width.
        const beatBounds = (typeof bl.findBeat === 'function')
            ? bl.findBeat(_svLastBeat) : null;
        if (!beatBounds || !beatBounds.visualBounds) {
            _svMarker.style.display = 'none'; return;
        }
        const bvb = beatBounds.visualBounds;

        // Find the staffSystem (row) that contains this beat's y coordinate,
        // and use its full visual height for the cursor.
        let sysTop = bvb.y, sysBottom = bvb.y + bvb.h;
        try {
            const systems = bl.staffSystems || [];
            for (const sys of systems) {
                const svb = sys && sys.visualBounds;
                if (!svb) continue;
                // Beat's y falls within this system row.
                if (bvb.y >= svb.y && bvb.y < svb.y + svb.h) {
                    sysTop    = svb.y;
                    sysBottom = svb.y + svb.h;
                    break;
                }
            }
        } catch (_) {}

        const baseX  = _svAtMount.offsetLeft;
        const baseY  = _svAtMount.offsetTop;
        const left   = Math.round(baseX + bvb.x);
        const topPx  = Math.round(baseY + sysTop);
        const width  = Math.max(2, Math.round(bvb.w));
        const height = Math.max(8, Math.round(sysBottom - sysTop));

        _svMarker.style.left    = left   + 'px';
        _svMarker.style.top     = topPx  + 'px';
        _svMarker.style.width   = width  + 'px';
        _svMarker.style.height  = height + 'px';
        _svMarker.style.display = '';

        // Auto-scroll to keep the marker in view.
        const viewW = _svContainer.clientWidth;
        const viewH = _svContainer.clientHeight;
        const padX  = Math.min(180, viewW * 0.3);
        const padY  = Math.min(100, viewH * 0.25);
        const relX  = left  - _svContainer.scrollLeft;
        const relY  = topPx - _svContainer.scrollTop;

        let tX = _svContainer.scrollLeft;
        let tY = _svContainer.scrollTop;
        let go = false;
        if (relX < padX || relX > viewW - padX) { tX = left  - viewW / 2; go = true; }
        if (relY < padY || relY > viewH - padY) { tY = topPx - viewH / 2; go = true; }
        if (go) {
            _svContainer.scrollTo({
                left: Math.max(0, tX),
                top:  Math.max(0, tY),
                behavior: 'auto',
            });
        }
    }

    // ── Teardown ───────────────────────────────────────────────────

    function _svTeardown(restoreCanvas) {
        _svApiReady       = false;
        _svSoundFontReady = false;
        _svPlayerTick     = -1;
        _svLastTick       = -1;
        _svLastBeat       = null;
        _svAtBeats        = [];
        _svLatestBeats    = null;
        _svCurrentFile    = null;
        _svCurrentArr     = null;
        _svLoadingFile    = null;
        _svLoadingArr     = null;
        _svFailedFile     = null;
        _svFailedArr      = null;
        _svInfo           = null;
        _svMeasures       = [];
        _svNotationReady  = false;
        _svRendered       = false;
        _svPendingPlay    = false;
        _svPlayBtn        = null;
        _svStopBtn        = null;
        _svSynthPlaying   = false;

        // Restore OGG if we paused it on behalf of alphaSynth.
        if (_svOggPausedByUs) {
            _svOggPausedByUs = false;
            const audio = document.getElementById('audio');
            if (audio) { try { audio.play(); } catch (_) {} }
        }

        _svRemoveSongBridge();
        _svCloseWs();

        if (_svApi) {
            try { _svApi.stop(); }    catch (_) {}
            try { _svApi.destroy(); } catch (_) {}
            _svApi = null;
        }

        _svRemoveContainer();
        _svRemoveErrorBanner();

        if (restoreCanvas && _svHighwayCanvas) {
            _svHighwayCanvas.style.visibility = _svPrevVisibility;
            _svSetHighwayVisible(null);
            _svHighwayCanvas  = null;
            _svPrevVisibility = '';
        }
    }

    // ── setRenderer contract ───────────────────────────────────────

    return {
        contextType: '2d',   // we don't paint to the canvas ourselves;
                             // declared so the factory doesn't trigger
                             // an unnecessary canvas swap.

        init(canvas, bundle) {
            // Full teardown at init start clears any stale failed-load
            // state so re-picking this renderer always retries cleanly.
            _svTeardown(/* restoreCanvas */ true);
            window.removeEventListener('resize', _onWinResize);

            const myToken     = ++_svInitToken;
            _svHighwayCanvas  = canvas;
            _svPrevVisibility = canvas ? canvas.style.visibility : '';
            _svLastTick       = -1;

            window.addEventListener('resize', _onWinResize);

            const songInfo = (bundle && bundle.songInfo) || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _svFilename;
            const arrIdx   = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;

            _svConnectAndLoad(filename, arrIdx, myToken);
            _isReady = true;
        },

        draw(bundle) {
            if (!_isReady || !bundle) return;

            _svLatestBeats = bundle.beats || null;

            // Detect song/arrangement change → open a new WS.
            const songInfo = bundle.songInfo || {};
            const filename = (typeof songInfo.filename === 'string' && songInfo.filename)
                || _svFilename;
            const arrIdx   = Number.isInteger(songInfo.arrangement_index)
                ? songInfo.arrangement_index : 0;

            const chartChanged    = filename &&
                (filename !== _svCurrentFile || arrIdx !== _svCurrentArr);
            const loadInFlight    = _svLoadingFile !== null &&
                _svLoadingFile === filename && _svLoadingArr === arrIdx;
            const previouslyFailed = _svFailedFile === filename &&
                _svFailedArr === arrIdx;

            if (chartChanged && !loadInFlight && !previouslyFailed) {
                if (_resolveMount(_svHighwayCanvas)) {
                    const myToken = ++_svInitToken;
                    _svLastTick   = -1;
                    _svConnectAndLoad(filename, arrIdx, myToken);
                }
            }

            _svSyncCursor(bundle.currentTime);
        },

        resize(/* w, h */) {
            if (!_isReady) return;
            _svSizeContainer();
            if (_svApi) {
                try { _svApi.render(); } catch (_) {}
            }
        },

        destroy() {
            _isReady = false;
            _svInitToken++;
            window.removeEventListener('resize', _onWinResize);
            _svTeardown(/* restoreCanvas */ true);
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Register factory + auto-match predicate
// ═══════════════════════════════════════════════════════════════════════

window.slopsmithViz_staffview = createFactory;
// slopsmith→feedBack rename: host viz picker looks up `window.feedBackViz_<id>`.
window.feedBackViz_staffview = window.slopsmithViz_staffview;

// Auto-activates when the active arrangement carries notation data.
// songInfo.has_notation is set by server.py from LoadedSloppak.notation_by_id.
window.slopsmithViz_staffview.matchesArrangement = function (songInfo) {
    return !!(songInfo && songInfo.has_notation);
};

})();
