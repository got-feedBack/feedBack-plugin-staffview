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
//   - No alphaTab synth: the host owns audio (OGG). enablePlayer:false drops
//     the soundfont CDN download entirely, same rationale as tabview.
//   - Cursor sync: bundle.beats → tick lookup drives the marker
//   - Options pill (v3 plugin-control slot / v2 #player-footer / splitscreen
//     panel): LAYOUT (page/horizontal) and ZOOM controls, persisted to
//     localStorage
//   - Note explorer: alt+click (desktop) / double-tap (touch) a notehead
//     shows a pitch tooltip instead of seeking; toggleable in the pill
//   - OGG loop: click-drag (or touch-drag) across the score sets a loop
//     region via the platform's native setLoop() API, with a green overlay
//     that also mirrors loops set through the platform's own controls
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

// localStorage keys for pill-controlled, session-persisted preferences.
const _SV_STORE_LAYOUT         = 'staffview_layout';
const _SV_STORE_SCALE          = 'staffview_scale';
const _SV_STORE_NOTE_EXPLORER  = 'staffview_note_explorer';

// Pitch name lookup tables for _svPitchLabel(), keyed by MIDI pitch class
// (note.tone, 0-11). Sharp spelling used when key signature >= 0 or
// accidentalMode is ForceSharp; flat spelling when key signature < 0 or
// accidentalMode is ForceFlat.
const _SV_NOTE_EN_S  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const _SV_NOTE_SOL_S = ['DO','DO#','RE','RE#','MI','FA','FA#','SOL','SOL#','LA','LA#','SI'];
const _SV_NOTE_EN_F  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const _SV_NOTE_SOL_F = ['DO','REb','RE','MIb','MI','FA','SOLb','SOL','LAb','LA','SIb','SI'];

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons
// ═══════════════════════════════════════════════════════════════════════

let _svFilename       = null;   // captured from playSong wrap + arrangement:changed
let _nextInstanceId   = 0;
let _atLoadPromise    = null;   // memoized alphaTab CDN script load

// ═══════════════════════════════════════════════════════════════════════
// localStorage helpers (swallow quota / privacy-mode errors)
// ═══════════════════════════════════════════════════════════════════════

function _svReadStore(k)    { try { return localStorage.getItem(k); }     catch (_) { return null; } }
function _svSaveStore(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }

// Zoom clamp: 50%-200% in 5% steps. Pulled out of _svSetScale so the pure
// math is independently testable (tests/zoom.test.js).
function _svClampScale(value) {
    return Math.max(0.5, Math.min(2.0, Math.round(value * 20) / 20));
}

// Normalizes the two possible loop-notification payload shapes into
// { startTime, endTime } (or null if neither is present).
//   loop:restart        → detail = { loopA, loopB, time }
//   playback:loop-set   → detail = { payload: { loop: { startTime, endTime, ... } }, ... }
function _svParseLoopEventDetail(detail) {
    const d = detail || {};
    if (d.payload && d.payload.loop
        && typeof d.payload.loop.startTime === 'number'
        && typeof d.payload.loop.endTime === 'number') {
        return { startTime: d.payload.loop.startTime, endTime: d.payload.loop.endTime };
    }
    if (typeof d.loopA === 'number' && typeof d.loopB === 'number') {
        return { startTime: d.loopA, endTime: d.loopB };
    }
    return null;
}

// Returns [earlier, later] sorted by absoluteDisplayStart (or
// absolutePlaybackStart) tick — used to normalize a drag gesture's
// start/end beats regardless of which direction the user dragged.
function _svOrderBeats(beatA, beatB) {
    const tA = typeof beatA.absoluteDisplayStart === 'number' ? beatA.absoluteDisplayStart
        : (typeof beatA.absolutePlaybackStart === 'number' ? beatA.absolutePlaybackStart : 0);
    const tB = typeof beatB.absoluteDisplayStart === 'number' ? beatB.absoluteDisplayStart
        : (typeof beatB.absolutePlaybackStart === 'number' ? beatB.absolutePlaybackStart : 0);
    return tA <= tB ? [beatA, beatB] : [beatB, beatA];
}

// A drag delta past its dead zone arms a loop only when it is horizontally
// dominant (a scrub across beats), not vertical (an imprecise click or a
// scroll). Shared by the mouse and touch drag paths so both gate identically.
// Diagonal (|dx| === |dy|) counts as horizontal, matching the touch path's
// original `abs(dy) > abs(dx)` disarm test.
function _svIsHorizontalDrag(dx, dy) {
    return Math.abs(dx) >= Math.abs(dy);
}

// A loop whose start and end resolve to the same (or inverted) time is a
// degenerate zero-length loop — never commit it; the caller treats it as a
// no-op. Also rejects unresolved (non-number) times.
function _svIsValidLoopSpan(timeA, timeB) {
    return typeof timeA === 'number' && typeof timeB === 'number' && timeB > timeA;
}

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
        window.feedBack &&
        typeof window.feedBack.on === 'function' &&
        !window.__feedBackStaffviewArrangementSubscribed
    ) {
        window.feedBack.on('arrangement:changed', (e) => {
            if (e && e.detail && e.detail.filename) _svFilename = e.detail.filename;
        });
        window.__feedBackStaffviewArrangementSubscribed = true;
    }
})();

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helpers (mirrors tabview — only panelChromeFor needed)
// ═══════════════════════════════════════════════════════════════════════

// The published splitscreen plugin currently exports only the pre-rename
// window.slopsmithSplitscreen global (core's highway_3d reads
// window.feedBackSplitscreen instead, which nothing defines) — read both,
// preferring the current name, so staffview keeps working with whichever
// splitscreen build is installed.
function _ssActive() {
    const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor === 'function';
}

function _resolveMount(canvas) {
    if (_ssActive()) {
        const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
        return ss.panelChromeFor(canvas);
    }
    return document.getElementById('player');
}

// v3 player chrome (docs/plugin-v3-ui.md): v3's #player-hud / #player-controls
// are position:absolute overlays that consume no layout space, so container
// sizing must not subtract their heights (see _svSizeContainer). _isV3() also
// gates the pill mount path below.
function _isV3() {
    return !!(window.feedBack && window.feedBack.uiVersion === 'v3');
}

// v3 controls injected into the player must mount into the stable
// plugin-control slot instead of the auto-hiding transport / footer.
// Returns null on v2 so callers fall back to #player-footer unchanged.
function _playerSlot() {
    return (_isV3()
        && window.feedBack.ui
        && typeof window.feedBack.ui.playerControlSlot === 'function')
        ? window.feedBack.ui.playerControlSlot() : null;
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

// Returns an 'En / Sol' pitch label for a single alphaTab note, e.g.
// 'C#4 / DO#4'. Respects note.accidentalMode (Force* values override
// key-signature spelling); falls back to key-signature-derived sharp/flat
// when accidentalMode is Default(0) or ForceNone(1): positive key
// signature = sharp keys, negative = flat keys.
// AccidentalMode enum (verified from AT 1.8.2 source): Default=0
// ForceNone=1 ForceNatural=2 ForceSharp=3 ForceDoubleSharp=4 ForceFlat=5
// ForceDoubleFlat=6.
function _svPitchLabel(note) {
    const tone   = note.tone;                        // 0-11
    const octave = note.octave;
    const am     = (note.accidentalMode != null) ? note.accidentalMode : 0;
    let ks = 0;
    try { ks = note.beat.voice.bar.masterBar.keySignature || 0; } catch (_) {}

    let en, sol;
    if (am === 3) {                                  // ForceSharp
        en = _SV_NOTE_EN_S[tone]; sol = _SV_NOTE_SOL_S[tone];
    } else if (am === 5) {                           // ForceFlat
        en = _SV_NOTE_EN_F[tone]; sol = _SV_NOTE_SOL_F[tone];
    } else if (am === 4) {                           // ForceDoubleSharp
        const dsEn  = [null,'B##','C##',null,'D##',null,'E##','F##',null,'G##',null,'A##'];
        const dsSol = [null,'SI##','DO##',null,'RE##',null,'MI##','FA##',null,'SOL##',null,'LA##'];
        en  = dsEn[tone]  || _SV_NOTE_EN_S[tone]  + '(##)';
        sol = dsSol[tone] || _SV_NOTE_SOL_S[tone] + '(##)';
    } else if (am === 6) {                           // ForceDoubleFlat
        const dfEn  = ['Dbb',null,'Ebb','Fbb',null,'Gbb',null,'Abb',null,'Bbb','Cbb',null];
        const dfSol = ['REbb',null,'MIbb','FAbb',null,'SOLbb',null,'LAbb',null,'SIbb','DObb',null];
        en  = dfEn[tone]  || _SV_NOTE_EN_F[tone]  + '(bb)';
        sol = dfSol[tone] || _SV_NOTE_SOL_F[tone] + '(bb)';
    } else if (am === 2) {                           // ForceNatural
        en = _SV_NOTE_EN_S[tone] + '♮'; sol = _SV_NOTE_SOL_S[tone] + '♮';
    } else {                                         // Default(0) / ForceNone(1)
        en  = ks < 0 ? _SV_NOTE_EN_F[tone]  : _SV_NOTE_EN_S[tone];
        sol = ks < 0 ? _SV_NOTE_SOL_F[tone] : _SV_NOTE_SOL_S[tone];
    }
    // note.octave is alphaTab's internal floor(midi/12); scientific-pitch
    // notation puts middle C (MIDI 60) at C4, so the printed octave is -1.
    const sci = octave - 1;
    return en + sci + ' / ' + sol + sci;
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
                // NB: isEmpty must stay false — isEmpty=true tells alphaTab to
                // skip the beat entirely (no glyph), which is exactly the
                // "rests not rendering" bug this guards against. With no notes
                // added alphaTab derives isRest from notes.length === 0 and
                // draws the whole-rest glyph.
                if (voice.beats.length === 0) {
                    const rest    = new m.Beat();
                    rest.voice    = voice;
                    rest.duration = m.Duration ? m.Duration.Whole : 1;
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

    // ── Note explorer (alt-click / double-tap pitch tooltip) ────────
    // _svNoteExplorerEnabled: pill checkbox, persisted, default on.
    // _svTooltip: reused div, created lazily on first show.
    // _svTooltipTimer/_svTooltipDismiss: auto-dismiss after 4s or on the
    // next mousedown anywhere (capture-phase, one-shot).
    let _svNoteExplorerEnabled = _svReadStore(_SV_STORE_NOTE_EXPLORER) !== 'false';
    let _svTooltip        = null;
    let _svTooltipTimer   = null;
    let _svTooltipDismiss = null;

    // ── Double-tap state (mobile note explorer — alt+click has no touch
    // equivalent) ────────────────────────────────────────────────────
    let _svLastTapTime  = 0;   // ms timestamp of the previous touchend
    let _svLastTapX     = 0;   // canvas-space x of the previous tap
    let _svLastTapY     = 0;   // canvas-space y of the previous tap

    // ── OGG loop (drag-select region + overlay) ─────────────────────
    // _svOwnsOggLoop: true only while WE hold the platform loop (set via our
    // own drag) — teardown/song-switch only clears a loop we set ourselves,
    // never one the user set through the platform's own native A/B controls.
    // _svLoopGen: bumped on every _svClearLoop() call; _svApplyOggLoop's
    // async continuation bails if the generation moved on while it awaited
    // the platform's setLoop() response (e.g. user cleared or re-dragged
    // mid-request).
    // _svLoopStartBeat/_svLoopEndBeat: the committed loop's AT Beat objects
    // (not raw seconds) so the overlay repositions correctly across
    // layout/zoom changes via the same boundsLookup-driven path as the
    // playback marker.
    let _svOwnsOggLoop   = false;
    let _svLoopGen       = 0;
    let _svLoopStartBeat = null;
    let _svLoopEndBeat   = null;
    let _svLoopMarkerA   = null;   // green bar — loop start
    let _svLoopMarkerB   = null;   // green bar — loop end
    let _svLoopRegionWrap = null;  // container for the region-rect divs
    let _svLoopClearedHandler = null; // platform 'playback:loop-cleared' listener
    let _svLoopSetHandler     = null; // platform 'playback:loop-set'/'loop:restart' listener

    // Drag-select gesture state, shared between the mouse (mousedown on
    // document mousemove/mouseup) and touch (touchstart/touchmove/touchend)
    // paths so both funnel into the same _svApplyOggLoop() call.
    let _svDragArmed        = false;
    let _svDragActive       = false;   // 14px (mouse: 8px) threshold crossed
    let _svDragStartClientX = 0;
    let _svDragStartClientY = 0;
    let _svDragBeat         = null;
    let _svDragCleanup      = null;    // fn to remove the dynamic mousemove/mouseup pair

    // ── Layout mode and zoom (persisted, read once at factory creation) ────
    // Stored as plain values so instance creation doesn't touch alphaTab
    // (not loaded yet) — applied to the AlphaTabApi settings in _svInitAlphaTab.
    let _svLayoutIsHoriz = _svReadStore(_SV_STORE_LAYOUT) === 'horizontal';
    let _svScaleStored   = parseFloat(_svReadStore(_SV_STORE_SCALE));
    let _svScale         = _svClampScale(Number.isFinite(_svScaleStored) ? _svScaleStored : 1.0);
    let _svLayoutPageBtn  = null;
    let _svLayoutHorizBtn = null;
    let _svZoomLabel      = null;
    let _svZoomMinusBtn   = null;
    let _svZoomPlusBtn    = null;
    let _svMarkerRefreshTimer = null; // bounded poll after a settings-only render

    // ── Options pill / popover UI state ─────────────────────────────
    // _svPillWrap: the wrapper element appended to the v3 plugin-control
    // slot, v2 #player-footer, or the splitscreen panel. Removed in
    // _svRemovePill(). _svPillRetries/_svPillRetryTimer/_svSlotObserver:
    // the v3 slot may not exist yet on first mount attempt — poll a bounded
    // number of times, then fall back to a one-shot MutationObserver.
    // _svPopoverCloseHandler/_svPopoverDeferTimer: the capture-phase
    // document mousedown listener that closes the popover on outside click;
    // must be torn down in _svRemovePill() even if the popover is open at
    // teardown time, or the listener survives and pins the detached DOM.
    let _svPillWrap             = null;
    let _svPillRetryTimer       = null;
    let _svPillRetries          = 0;
    const _SV_PILL_MAX_RETRIES  = 20;   // ~5s of 250ms polls for the v3 slot
    let _svSlotObserver         = null; // MutationObserver fallback when polls exhaust
    let _svPopoverCloseHandler  = null;
    let _svPopoverDeferTimer    = null;

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
            // Horizontal layout is a single short row — centre it vertically
            // to use the container height. Kept in sync at runtime by
            // _svSetLayout(); _svAtMount.offsetTop-based overlay positioning
            // (marker, tooltips) needs no further changes for this.
            _svLayoutIsHoriz ? 'display:flex;align-items:center' : '',
        ].filter(Boolean).join(';');

        const inner = document.createElement('div');
        inner.id = 'staffview-at-' + _instanceId;
        // In flex context a child div shrinks to content instead of filling
        // 100% of the parent; alphaTab measures this div's width before
        // rendering and skips entirely when it reads 0 — explicit width
        // keeps horizontal-layout loads from rendering blank.
        inner.style.width = '100%';
        // Disables the browser's native double-tap zoom so the touchend
        // handler below can use double-tap for the note explorer.
        inner.style.touchAction = 'manipulation';
        // Prevents iOS's text-selection magnifier from firing when a finger
        // drags across the notation surface (SVG — nothing meaningful to
        // select). Belt-and-suspenders: the touchmove drag handler below
        // also calls preventDefault() once a horizontal drag is confirmed.
        inner.style.userSelect       = 'none';
        inner.style.webkitUserSelect = 'none';
        inner.addEventListener('selectstart', (e) => e.preventDefault());
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

        // Loop overlay: green A/B marker bars + a region-rect wrapper,
        // initially hidden (Group B1-a).
        function _mkLoopMarker(label) {
            const m = document.createElement('div');
            m.style.cssText = [
                'position:absolute', 'top:0', 'left:0', 'width:2px', 'height:0',
                'background:#22c55e', 'pointer-events:none', 'z-index:998', 'display:none',
            ].join(';');
            const badge = document.createElement('span');
            badge.textContent = label;
            badge.style.cssText = [
                'position:absolute', 'top:0', 'left:3px',
                'font-size:10px', 'color:#22c55e', 'font-family:monospace',
                'font-weight:bold', 'line-height:1', 'pointer-events:none',
            ].join(';');
            m.appendChild(badge);
            return m;
        }
        const loopMarkerA    = _mkLoopMarker('A');
        const loopMarkerB    = _mkLoopMarker('B');
        const loopRegionWrap = document.createElement('div');
        loopRegionWrap.style.cssText =
            'position:absolute;top:0;left:0;pointer-events:none;z-index:997;overflow:visible;';
        c.appendChild(loopMarkerA);
        c.appendChild(loopMarkerB);
        c.appendChild(loopRegionWrap);

        mount.appendChild(c);
        _svContainer      = c;
        _svAtMount        = inner;
        _svMarker         = marker;
        _svLoopMarkerA    = loopMarkerA;
        _svLoopMarkerB    = loopMarkerB;
        _svLoopRegionWrap = loopRegionWrap;

        // ── Interaction model ────────────────────────────────────────
        //   Alt+click        → note explorer pitch tooltip
        //   Drag (> 8px)      → set loop region (drag-select)
        //   Short click       → seek cursor
        // mousedown arms drag state; dynamic mousemove/mouseup listeners on
        // document decide the outcome once the gesture completes (mirrors
        // the pill's own bounded-retry style of deferred decision-making).
        inner.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || !_svApi || !_svApiReady) return;
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

            // Alt+click → note explorer tooltip; suppresses seek/drag for
            // this click (no-op, falls through to nothing, if the beat is
            // a rest).
            if (e.altKey && _svNoteExplorerEnabled) {
                if (beat.notes && beat.notes.length > 0) {
                    _svShowNoteTooltip(beat, x, y);
                }
                return;
            }

            // Cancel any stale drag listeners from a previous gesture.
            if (_svDragCleanup) { _svDragCleanup(); _svDragCleanup = null; }

            _svDragArmed        = true;
            _svDragActive       = false;
            _svDragStartClientX = e.clientX;
            _svDragStartClientY = e.clientY;
            _svDragBeat         = beat;

            const onMove = (ev) => {
                if (!_svDragArmed) return;
                if (!_svDragActive) {
                    const dx = ev.clientX - _svDragStartClientX;
                    const dy = ev.clientY - _svDragStartClientY;
                    if (Math.hypot(dx, dy) <= 8) return;
                    // Horizontal-dominance gate (mirrors the touch path): a
                    // mostly-vertical move is an imprecise click, not a loop.
                    // Disarm so onUp seeks; keep _svDragBeat (unlike touch) so
                    // that seek can still resolve the start beat.
                    if (!_svIsHorizontalDrag(dx, dy)) { _svDragArmed = false; return; }
                    _svDragActive = true;
                }
                const bll = _svApi && _svApi.boundsLookup;
                if (!bll || typeof bll.getBeatAtPos !== 'function') return;
                const rc  = inner.getBoundingClientRect();
                const cx  = ev.clientX - rc.left + inner.scrollLeft;
                const cy  = ev.clientY - rc.top  + inner.scrollTop;
                let endBeat;
                try { endBeat = bll.getBeatAtPos(cx, cy); } catch (_) { return; }
                if (endBeat) _svDrawLoopPreview(_svDragBeat, endBeat);
            };

            const onUp = (ev) => {
                _svDragCleanup && _svDragCleanup();
                _svDragCleanup = null;

                const wasActive = _svDragActive;
                const startBeat = _svDragBeat;
                _svDragArmed  = false;
                _svDragActive = false;
                _svDragBeat   = null;
                _svClearLoopPreview();

                if (!startBeat || !_svApi || !_svApiReady) return;

                if (wasActive) {
                    // Drag → set loop.
                    const bll = _svApi && _svApi.boundsLookup;
                    if (!bll || typeof bll.getBeatAtPos !== 'function') return;
                    const rc = inner.getBoundingClientRect();
                    const ex = ev.clientX - rc.left + inner.scrollLeft;
                    const ey = ev.clientY - rc.top  + inner.scrollTop;
                    let endBeat;
                    try { endBeat = bll.getBeatAtPos(ex, ey); } catch (_) {}
                    if (!endBeat) endBeat = startBeat;
                    const [beatA, beatB] = _svOrderBeats(startBeat, endBeat);
                    _svApplyOggLoop(beatA, beatB);
                } else {
                    // Short click → seek.
                    const beat2 = startBeat;
                    const tick = typeof beat2.absoluteDisplayStart === 'number'
                        ? beat2.absoluteDisplayStart
                        : (typeof beat2.absolutePlaybackStart === 'number'
                            ? beat2.absolutePlaybackStart : null);
                    if (tick === null) return;
                    _svLastTick = tick;
                    _svLastBeat = beat2;
                    _svUpdateMarker();
                    const secs = _svBeatToSeconds(beat2);
                    if (secs !== null) {
                        const audio = document.getElementById('audio');
                        if (audio) { try { audio.currentTime = secs; } catch (_) {} }
                    }
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
            _svDragCleanup = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            };
        });

        // Double-tap → note explorer (mobile equivalent of alt+click; touch
        // devices have no alt key). touch-action:manipulation on inner
        // (set above) already disables the browser's native double-tap
        // zoom; preventDefault() here suppresses the synthesized mouse
        // events that would otherwise follow the second tap.
        inner.addEventListener('touchend', (e) => {
            if (!_svNoteExplorerEnabled || !_svApi || !_svApiReady) return;
            const t = e.changedTouches[0];
            if (!t) return;
            const rect = inner.getBoundingClientRect();
            const x = t.clientX - rect.left + inner.scrollLeft;
            const y = t.clientY - rect.top  + inner.scrollTop;
            const now = Date.now();
            const dt  = now - _svLastTapTime;
            const dx  = x - _svLastTapX;
            const dy  = y - _svLastTapY;
            if (dt < 300 && Math.hypot(dx, dy) < 30) {
                // Second tap within window — treat as double-tap.
                e.preventDefault();
                _svLastTapTime = 0; // reset so a triple-tap doesn't re-trigger
                const bl = _svApi.boundsLookup;
                if (!bl || typeof bl.getBeatAtPos !== 'function') return;
                let beat;
                try { beat = bl.getBeatAtPos(x, y); } catch (_) { return; }
                if (beat && beat.notes && beat.notes.length > 0) {
                    _svShowNoteTooltip(beat, x, y);
                }
            } else {
                _svLastTapTime = now;
                _svLastTapX    = x;
                _svLastTapY    = y;
            }
        });

        // Touch drag → loop region (mobile equivalent of the mouse drag
        // above). touchstart arms the drag using the same shared state vars
        // as the mousedown path. The dead zone is wider than the mouse path
        // (14px vs 8px) to absorb natural finger tremor, and a
        // predominantly-vertical first movement disarms the drag and yields
        // to native container scroll instead of hijacking it —
        // preventDefault() only fires once a horizontal drag is confirmed.
        // touchend with an active drag calls preventDefault() to suppress
        // the synthetic mousedown/click the browser would otherwise
        // generate, so the loop gesture isn't immediately followed by an
        // accidental seek. Single taps fall through to the existing
        // synthesized mousedown handler unchanged.
        inner.addEventListener('touchstart', (e) => {
            if (!_svApi || !_svApiReady) return;
            const t = e.touches[0];
            if (!t) return;
            const bl = _svApi.boundsLookup;
            if (!bl || typeof bl.getBeatAtPos !== 'function') return;
            const rect = inner.getBoundingClientRect();
            const x = t.clientX - rect.left + inner.scrollLeft;
            const y = t.clientY - rect.top  + inner.scrollTop;
            let beat;
            try { beat = bl.getBeatAtPos(x, y); } catch (_) { return; }
            if (!beat) return;
            if (_svDragCleanup) { _svDragCleanup(); _svDragCleanup = null; }
            _svDragArmed        = true;
            _svDragActive       = false;
            _svDragStartClientX = t.clientX;
            _svDragStartClientY = t.clientY;
            _svDragBeat         = beat;
        }, { passive: true });

        inner.addEventListener('touchmove', (e) => {
            if (!_svDragArmed) return;
            const t = e.touches[0];
            if (!t) return;
            if (!_svDragActive) {
                const dx = t.clientX - _svDragStartClientX;
                const dy = t.clientY - _svDragStartClientY;
                if (Math.hypot(dx, dy) <= 14) return;
                // Vertical intent → disarm and yield to native scroll.
                if (!_svIsHorizontalDrag(dx, dy)) {
                    _svDragArmed = false;
                    _svDragBeat  = null;
                    return;
                }
                _svDragActive = true;
            }
            e.preventDefault(); // stop iOS scroll and selection once horizontal drag is confirmed
            const bll = _svApi && _svApi.boundsLookup;
            if (!bll || typeof bll.getBeatAtPos !== 'function') return;
            const rc = inner.getBoundingClientRect();
            const cx = t.clientX - rc.left + inner.scrollLeft;
            const cy = t.clientY - rc.top  + inner.scrollTop;
            let endBeat;
            try { endBeat = bll.getBeatAtPos(cx, cy); } catch (_) { return; }
            if (endBeat) _svDrawLoopPreview(_svDragBeat, endBeat);
        }, { passive: false });

        inner.addEventListener('touchend', (e) => {
            if (!_svDragArmed) return;
            const wasActive = _svDragActive;
            const startBeat = _svDragBeat;
            _svDragArmed  = false;
            _svDragActive = false;
            _svDragBeat   = null;
            _svClearLoopPreview();
            if (!wasActive || !startBeat || !_svApi || !_svApiReady) return;
            // Suppress synthetic mousedown/click so the drag isn't followed
            // by an accidental seek.
            e.preventDefault();
            const t = e.changedTouches[0];
            if (!t) return;
            const bll = _svApi && _svApi.boundsLookup;
            if (!bll || typeof bll.getBeatAtPos !== 'function') return;
            const rc = inner.getBoundingClientRect();
            const ex = t.clientX - rc.left + inner.scrollLeft;
            const ey = t.clientY - rc.top  + inner.scrollTop;
            let endBeat;
            try { endBeat = bll.getBeatAtPos(ex, ey); } catch (_) {}
            if (!endBeat) endBeat = startBeat;
            const [beatA, beatB] = _svOrderBeats(startBeat, endBeat);
            _svApplyOggLoop(beatA, beatB);
        }, { passive: false });

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
            _svContainer      = null;
            _svAtMount        = null;
            _svMarker         = null;
            _svLoopMarkerA    = null;
            _svLoopMarkerB    = null;
            _svLoopRegionWrap = null;
        }
    }

    // ── Note explorer tooltip ────────────────────────────────────────

    function _svTooltipDismissAll() {
        if (_svTooltipTimer) { clearTimeout(_svTooltipTimer); _svTooltipTimer = null; }
        if (_svTooltipDismiss) {
            document.removeEventListener('mousedown', _svTooltipDismiss, { capture: true });
            _svTooltipDismiss = null;
        }
        if (_svTooltip) { _svTooltip.style.display = 'none'; }
    }

    // Shows a floating pitch label near the click/tap position, clamped to
    // the visible (scrolled) area of _svContainer. One line per note in the
    // beat (chord support). Dismissed on the next mousedown anywhere or
    // after 4s.
    function _svShowNoteTooltip(beat, clickX, clickY) {
        const lines = beat.notes.map(_svPitchLabel);
        if (!lines.length) return;

        if (!_svTooltip) {
            const t = document.createElement('div');
            t.className = 'sv-note-tooltip';
            t.style.cssText = [
                'position:absolute',
                'padding:5px 10px',
                'border-radius:8px',
                'background:rgba(12,12,22,0.96)',
                'border:1px solid rgba(255,255,255,0.12)',
                'color:#e2e8f0',
                'font-family:monospace',
                'font-size:13px',
                'line-height:1.6',
                'white-space:pre',
                'pointer-events:none',
                'z-index:10',
                'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
            ].join(';');
            _svContainer.appendChild(t);
            _svTooltip = t;
        }

        // Dismiss any previous tooltip/timer BEFORE showing the new one —
        // doing this after `style.display = ''` would immediately hide the
        // tooltip we just showed.
        _svTooltipDismissAll();

        _svTooltip.textContent = lines.join('\n');
        _svTooltip.style.display = '';

        // Position near the click, offset into container coordinates, then
        // clamp to the currently-visible viewport of the scrollable container.
        const tw  = _svTooltip.offsetWidth  || 120;
        const th  = _svTooltip.offsetHeight || 40;
        const cw  = _svContainer.clientWidth;
        const ch  = _svContainer.clientHeight;
        const sl  = _svContainer.scrollLeft;
        const st  = _svContainer.scrollTop;
        const ox  = (_svAtMount ? _svAtMount.offsetLeft : 0);
        const oy  = (_svAtMount ? _svAtMount.offsetTop  : 0);
        const GAP = 8;
        let left = ox + clickX + GAP;
        let top  = oy + clickY - Math.round(th / 2);
        if (left + tw  > sl + cw - GAP) left = sl + cw - tw - GAP;
        if (left       < sl + GAP)      left = sl + GAP;
        if (top  + th  > st + ch - GAP) top  = st + ch - th - GAP;
        if (top        < st + GAP)      top  = st + GAP;
        _svTooltip.style.left = Math.round(left) + 'px';
        _svTooltip.style.top  = Math.round(top)  + 'px';

        _svTooltipTimer   = setTimeout(_svTooltipDismissAll, 4000);
        _svTooltipDismiss = () => _svTooltipDismissAll();
        document.addEventListener('mousedown', _svTooltipDismiss, { capture: true, once: true });
    }

    // ── OGG loop helpers ─────────────────────────────────────────────

    // Inverse of _svBeatToSeconds. bundle.beats[i] is the time at tick i*960
    // (one entry per quarter-note beat, same assumption _svBeatToSeconds
    // uses). Binary-search _svLatestBeats for the time, interpolate a
    // fractional beat index, convert to tick = (idx+frac)*960, then look up
    // the AT Beat via _svFindBeatAtTick. Used to mirror a loop set through
    // the platform's own native controls (seconds) into our AT-Beat-based
    // overlay.
    function _svTimeToNearestBeat(time) {
        const lb = _svLatestBeats;
        if (!lb || lb.length < 2) return null;
        if (time <= lb[0].time) return _svFindBeatAtTick(0);
        let lo = 0, hi = lb.length - 1, idx = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lb[mid].time <= time) { idx = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        let frac = 0;
        if (idx < lb.length - 1) {
            const t0 = lb[idx].time, t1 = lb[idx + 1].time;
            if (t1 > t0) frac = Math.min(1, (time - t0) / (t1 - t0));
        }
        return _svFindBeatAtTick(Math.round((idx + frac) * 960));
    }

    // Creates a single region-rect element (absolutely positioned in
    // _svContainer space).
    function _svMakeRegionRect(left, top, width, height) {
        const d = document.createElement('div');
        d.style.cssText = [
            'position:absolute',
            'background:rgba(34,197,94,0.12)',
            'border-top:1px solid rgba(34,197,94,0.3)',
            'border-bottom:1px solid rgba(34,197,94,0.3)',
            'pointer-events:none',
            'left:' + left + 'px',
            'top:'  + top  + 'px',
            'width:'  + width  + 'px',
            'height:' + height + 'px',
        ].join(';');
        return d;
    }

    // Positions a single loop marker (A or B) at the given beat.
    function _svPositionLoopMarker(marker, beat, side) {
        if (!marker || !_svAtMount) return false;
        const bl = _svApi && _svApi.boundsLookup;
        if (!bl || typeof bl.findBeat !== 'function') return false;
        const bb = bl.findBeat(beat);
        if (!bb || !bb.visualBounds) return false;
        const vb = bb.visualBounds;
        let sysTop = vb.y, sysH = vb.h;
        try {
            const systems = bl.staffSystems || [];
            for (const sys of systems) {
                const svb = sys && sys.visualBounds;
                if (!svb) continue;
                if (vb.y >= svb.y && vb.y < svb.y + svb.h) {
                    sysTop = svb.y; sysH = svb.h; break;
                }
            }
        } catch (_) {}
        const baseX = _svAtMount.offsetLeft;
        const baseY = _svAtMount.offsetTop;
        const left  = Math.round(baseX + (side === 'B' ? vb.x + vb.w : vb.x));
        marker.style.left    = left + 'px';
        marker.style.top     = Math.round(baseY + sysTop) + 'px';
        marker.style.height  = Math.round(sysH) + 'px';
        marker.style.display = '';
        return true;
    }

    // Positions both loop markers and fills the region rects for
    // beatA → beatB, spanning multiple staff-system rows when the loop
    // crosses a line break.
    function _svUpdateLoopOverlay(beatA, beatB) {
        if (!_svLoopMarkerA || !_svLoopMarkerB || !_svLoopRegionWrap || !_svAtMount) return;
        if (!beatA && !beatB) { _svHideLoopOverlay(); return; }

        // Partial state (drag in progress with only a start beat yet, or
        // A/B set independently by the platform's own controls before the
        // pair is complete) — show just the one marker.
        if (!beatA || !beatB) {
            _svHideLoopOverlay();
            if (beatA) _svPositionLoopMarker(_svLoopMarkerA, beatA, 'A');
            else       _svPositionLoopMarker(_svLoopMarkerB, beatB, 'B');
            return;
        }

        const bl = _svApi && _svApi.boundsLookup;
        if (!bl || typeof bl.findBeat !== 'function') { _svHideLoopOverlay(); return; }

        const bbA = bl.findBeat(beatA);
        const bbB = bl.findBeat(beatB);
        if (!bbA || !bbA.visualBounds || !bbB || !bbB.visualBounds) {
            _svHideLoopOverlay(); return;
        }

        const vbA   = bbA.visualBounds;
        const vbB   = bbB.visualBounds;
        const baseX = _svAtMount.offsetLeft;
        const baseY = _svAtMount.offsetTop;

        // Collect sorted staffSystem rows.
        const rows = [];
        try {
            const systems = bl.staffSystems || [];
            for (const sys of systems) {
                if (sys && sys.visualBounds) rows.push(sys.visualBounds);
            }
            rows.sort((a, b) => a.y - b.y);
        } catch (_) {}

        function findRow(vb) {
            for (const r of rows) {
                if (vb.y >= r.y && vb.y < r.y + r.h) return r;
            }
            return null;
        }

        const rowA = findRow(vbA);
        const rowB = findRow(vbB);

        _svPositionLoopMarker(_svLoopMarkerA, beatA, 'A');
        _svPositionLoopMarker(_svLoopMarkerB, beatB, 'B');

        _svLoopRegionWrap.innerHTML = '';

        if (!rowA || !rowB || rowA === rowB || Math.abs(rowA.y - rowB.y) < 1) {
            // Same system row.
            const left   = Math.round(baseX + Math.min(vbA.x, vbB.x));
            const right  = Math.round(baseX + Math.max(vbA.x + vbA.w, vbB.x + vbB.w));
            const top    = Math.round(baseY + (rowA ? rowA.y : Math.min(vbA.y, vbB.y)));
            const height = Math.round(rowA ? rowA.h : Math.max(vbA.h, vbB.h));
            if (right > left) {
                _svLoopRegionWrap.appendChild(_svMakeRegionRect(left, top, right - left, height));
            }
        } else {
            // Multi-row: span from rowA.y to rowB.y inclusive, one region
            // rect per row, clipped to the loop's start/end column on the
            // first/last row respectively.
            const spanned = rows.filter(r => r.y >= rowA.y && r.y <= rowB.y);
            for (const row of spanned) {
                let left, right;
                if (Math.abs(row.y - rowA.y) < 1) {
                    left  = Math.round(baseX + vbA.x);
                    right = Math.round(baseX + row.x + row.w);
                } else if (Math.abs(row.y - rowB.y) < 1) {
                    left  = Math.round(baseX + row.x);
                    right = Math.round(baseX + vbB.x + vbB.w);
                } else {
                    left  = Math.round(baseX + row.x);
                    right = Math.round(baseX + row.x + row.w);
                }
                const top    = Math.round(baseY + row.y);
                const height = Math.round(row.h);
                if (right > left) {
                    _svLoopRegionWrap.appendChild(
                        _svMakeRegionRect(left, top, right - left, height));
                }
            }
        }
    }

    function _svHideLoopOverlay() {
        if (_svLoopMarkerA)    _svLoopMarkerA.style.display = 'none';
        if (_svLoopMarkerB)    _svLoopMarkerB.style.display = 'none';
        if (_svLoopRegionWrap) _svLoopRegionWrap.innerHTML  = '';
    }

    function _svDrawLoopPreview(startBeat, endBeat) {
        if (!startBeat || !endBeat) return;
        const [beatA, beatB] = _svOrderBeats(startBeat, endBeat);
        _svUpdateLoopOverlay(beatA, beatB);
    }

    // After a drag ends without committing (or is cancelled): restore
    // whatever loop state was already committed, or hide if none.
    function _svClearLoopPreview() {
        _svUpdateLoopOverlay(_svLoopStartBeat, _svLoopEndBeat);
    }

    // Applies a loop via the platform's native setLoop() API. Shows the
    // overlay immediately (optimistic); rolls back to the previously
    // committed state if the platform rejects the request.
    async function _svApplyOggLoop(beatA, beatB) {
        const timeA = _svBeatToSeconds(beatA);
        const timeB = _svBeatToSeconds(beatB);
        // Reject unresolved times and degenerate zero-length loops (drag
        // start and end on the same beat) — treat as a no-op, not a loop.
        if (!_svIsValidLoopSpan(timeA, timeB)) return;

        // Capture the generation so a concurrent _svClearLoop (or a second,
        // faster drag) can invalidate this continuation.
        const gen = ++_svLoopGen;

        _svUpdateLoopOverlay(beatA, beatB);

        let result;
        try { result = await window.feedBack.setLoop(timeA, timeB); }
        catch (_) { result = false; }

        if (gen !== _svLoopGen) return;

        if (result === false) {
            _svUpdateLoopOverlay(_svLoopStartBeat, _svLoopEndBeat);
            return;
        }

        _svOwnsOggLoop   = true;
        _svLoopStartBeat = beatA;
        _svLoopEndBeat   = beatB;
        _svUpdateLoopOverlay(beatA, beatB);
    }

    // Clears a loop WE set. Never clears a loop the platform's own native
    // controls set (_svOwnsOggLoop stays false in that case) — teardown/
    // song-switch should not steal a loop the user set through the
    // platform's own UI.
    function _svClearLoop() {
        _svLoopGen++;   // invalidate any pending _svApplyOggLoop continuation

        if (_svOwnsOggLoop) {
            try { window.feedBack.clearLoop(); } catch (_) {}
            _svOwnsOggLoop = false;
        }
        _svLoopStartBeat = null;
        _svLoopEndBeat   = null;
        _svHideLoopOverlay();
    }

    // ── Layout mode and zoom controls ───────────────────────────────

    // A settings-only re-render (updateSettings()+render(), no score reload)
    // does not reliably leave boundsLookup and the DOM reflow both settled
    // by the time renderFinished fires — measured empirically: toggling
    // layout can return boundsLookup geometry frozen from the *previous*
    // layout, and/or an unsettled container flex-centering offset. How long
    // this takes to settle scales with the score's actual layout complexity
    // (note density, page/system count) rather than elapsed frames — a
    // short piece settles within a couple of frames, a dense multi-page one
    // can take noticeably longer — so a fixed frame-count delay isn't
    // reliable. Poll on a bounded interval instead (same shape as the pill's
    // bounded slot-retry above); repeated _svUpdateMarker() calls are cheap
    // and idempotent, so polling past the point of settling is harmless.
    function _svRefreshMarkerAfterSettingsRender() {
        if (_svMarkerRefreshTimer) { clearInterval(_svMarkerRefreshTimer); _svMarkerRefreshTimer = null; }
        let tries   = 0;
        let lastSig = null;
        // Absolute safety cap only — NOT the intended stop condition. A
        // fixed try count (equivalently, a fixed wall-clock window) has the
        // same flaw as the earlier fixed-animation-frame attempt: settle
        // time scales with the machine's speed and the score's layout
        // complexity, not elapsed polls, so any fixed bound can in
        // principle still be too short. The real stop condition below is
        // "the marker's own computed geometry stopped changing between two
        // consecutive polls" — that adapts to however long the machine
        // actually needs. This cap only prevents a pathological case (or
        // active playback, whose own _svSyncCursor legitimately keeps the
        // marker moving every frame) from pinning the interval open forever.
        const MAX_TRIES = 80; // ~12s of 150ms polls
        _svMarkerRefreshTimer = setInterval(() => {
            tries += 1;
            _svUpdateMarker();
            // _svUpdateMarker() only ever mutates left/top/width/height/
            // display on this element, so its cssText fully captures
            // whether this poll actually changed anything visible.
            const sig = _svMarker ? _svMarker.style.cssText : null;
            const settled = sig === null || sig === lastSig;
            lastSig = sig;
            if (settled || tries >= MAX_TRIES) {
                clearInterval(_svMarkerRefreshTimer);
                _svMarkerRefreshTimer = null;
            }
        }, 150);
    }

    function _svSetLayout(isHoriz) {
        _svLayoutIsHoriz = isHoriz;
        _svSaveStore(_SV_STORE_LAYOUT, isHoriz ? 'horizontal' : 'page');
        if (_svLayoutPageBtn) {
            _svLayoutPageBtn.style.opacity   = isHoriz ? '0.7' : '1';
            _svLayoutPageBtn.style.boxShadow = isHoriz ? '' : '0 0 0 1px #22c55e';
        }
        if (_svLayoutHorizBtn) {
            _svLayoutHorizBtn.style.opacity   = isHoriz ? '1' : '0.7';
            _svLayoutHorizBtn.style.boxShadow = isHoriz ? '0 0 0 1px #22c55e' : '';
        }
        if (_svContainer) {
            _svContainer.style.display    = isHoriz ? 'flex' : '';
            _svContainer.style.alignItems = isHoriz ? 'center' : '';
        }
        if (!_svApi) return;
        _svApi.settings.display.layoutMode = isHoriz
            ? alphaTab.LayoutMode.Horizontal
            : alphaTab.LayoutMode.Page;
        _svApi.updateSettings();
        _svApi.render();
        _svRefreshMarkerAfterSettingsRender();
    }

    function _svSetScale(value) {
        _svScale = _svClampScale(value);
        _svSaveStore(_SV_STORE_SCALE, String(_svScale));
        if (_svZoomLabel)    _svZoomLabel.textContent = Math.round(_svScale * 100) + '%';
        if (_svZoomMinusBtn) _svZoomMinusBtn.disabled = _svScale <= 0.5;
        if (_svZoomPlusBtn)  _svZoomPlusBtn.disabled  = _svScale >= 2.0;
        if (!_svApi) return;
        _svApi.settings.display.scale = _svScale;
        _svApi.updateSettings();
        _svApi.render();
        _svRefreshMarkerAfterSettingsRender();
    }

    // ── Options pill ─────────────────────────────────────────────────
    // A small pill button + popover injected into the v3 plugin-control
    // slot (main player), #player-footer (v2 main player), or the
    // splitscreen panelDiv, exposing formatting controls (layout, zoom).
    //
    // Uses platform CSS classes (.section-practice-pill, .v3-pop-btn, etc.)
    // so the pill looks native across v2 and v3. The popover keeps a
    // staffview-specific id (sv-popover-{id}) to avoid colliding with
    // #section-practice-bar; its visual CSS is inlined to match the platform.
    //
    // Pill anchor:
    //   v3 main player → feedBack.ui.playerControlSlot() (bounded retry +
    //                     MutationObserver fallback if the slot isn't
    //                     mounted yet — see docs/plugin-v3-ui.md)
    //   v2 main player → document.getElementById('player-footer')
    //   Splitscreen     → _resolveMount (the panelDiv, position:relative);
    //                     pill wrapper gets position:absolute; bottom:0;
    //                     left:8px so it sits at panel bottom-left

    function _svCreatePill() {
        if (_svPillWrap) return;

        const inSS   = _ssActive();
        const slot   = inSS ? null : _playerSlot();
        // v3: never fall back to #player-footer — that element belongs to
        // the v2 chrome and auto-hides in v3. If the slot isn't ready yet
        // the retry path below keeps trying. v2 falls back normally.
        const footer = inSS ? _resolveMount(_svHighwayCanvas)
                            : (_isV3() ? slot : (slot || document.getElementById('player-footer')));
        if (!footer) {
            // v3 mounts the pill into the plugin-control slot, which the
            // rail popover may not have created yet on the first call.
            // Fast path: poll a bounded number of times (covers the common
            // case where the v3 slot appears within a few seconds of
            // startup). Fallback: if polls exhaust, arm a MutationObserver
            // on document.body that fires _svCreatePill exactly once when
            // the slot element arrives. Splitscreen and v2 have no
            // late-slot problem so they fall through to a single attempt.
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
        const wrap = document.createElement('div');
        wrap.id = 'sv-pill-wrap-' + _instanceId;
        wrap.className = 'section-practice-control'
            + (_isV3() && !inSS ? ' section-practice-control--v3' : '');
        if (inSS) {
            // Splitscreen absolute position is instance-specific — not a
            // platform concept, so it stays inline rather than in a class.
            wrap.style.cssText = 'position:absolute;bottom:0;left:8px;z-index:7';
        }

        // ── Pill button ───────────────────────────────────────────
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.id   = 'sv-pill-' + _instanceId;
        pill.className = 'section-practice-pill';
        pill.setAttribute('aria-haspopup', 'dialog');
        pill.setAttribute('aria-expanded', 'false');
        pill.setAttribute('aria-label', 'Staff View options');
        pill.title = 'Staff View';
        pill.innerHTML =
            '<span aria-hidden="true" class="section-practice-pill-icon">♩</span>'
            + '<span class="section-practice-pill-text">Staff View</span>'
            + '<span aria-hidden="true" class="section-practice-pill-caret">▾</span>';

        // ── Popover ───────────────────────────────────────────────
        // v3 non-splitscreen: popover opens rightward (the pill lives in
        // the icon rail, not the footer). Platform's v3 rule targets the
        // id #section-practice-bar so the override is applied here directly.
        const v3Popover = _isV3() && !inSS;
        const popover = document.createElement('div');
        popover.id    = 'sv-popover-' + _instanceId;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', 'Staff View options');
        popover.style.cssText = [
            'display:none',
            v3Popover ? 'position:absolute' : 'position:fixed',
            v3Popover ? 'left:calc(100% + 8px)' : 'left:50%',
            v3Popover ? 'top:0' : '',
            v3Popover ? '' : 'transform:translateX(-50%)',
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
            // Mobile: without a height cap the popover scrolls off the
            // bottom of the viewport on small screens. Harmless on desktop,
            // where the popover never reaches 80vh.
            'max-height:80vh',
            'overflow-y:auto',
            'overscroll-behavior:contain',
        ].join(';');

        // Header
        const hdr = document.createElement('span');
        hdr.className = 'section-practice-label';
        hdr.style.cssText = 'display:block;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:8px';
        hdr.textContent = 'Staff View';
        popover.appendChild(hdr);

        const btnCls = _isV3()
            ? 'v3-pop-btn'
            : 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';

        // ── NOTE EXPLORER section ──────────────────────────────────
        // Single checkbox for now. A future MIDI note-detection PR is
        // expected to grow this into a full "Note Detection" section
        // (Detect toggle, Clear-on-rewind) alongside this control.
        const explorerSection = document.createElement('div');

        const explorerRow = document.createElement('div');
        explorerRow.className = 'section-practice-controls-row';
        const explorerWrap = document.createElement('label');
        explorerWrap.className = 'section-practice-mode-wrap';
        const explorerCb = document.createElement('input');
        explorerCb.type    = 'checkbox';
        explorerCb.id      = 'sv-cb-note-explorer-' + _instanceId;
        explorerCb.checked = _svNoteExplorerEnabled;
        explorerCb.addEventListener('change', () => {
            _svNoteExplorerEnabled = explorerCb.checked;
            _svSaveStore(_SV_STORE_NOTE_EXPLORER, String(_svNoteExplorerEnabled));
        });
        const explorerText = document.createElement('span');
        explorerText.className = 'section-practice-mode-text';
        explorerText.textContent = 'Note explorer (alt+click / double-tap)';
        explorerWrap.appendChild(explorerCb);
        explorerWrap.appendChild(explorerText);
        explorerRow.appendChild(explorerWrap);
        explorerSection.appendChild(explorerRow);

        // ── LAYOUT section ────────────────────────────────────────
        const layoutSection = document.createElement('div');
        layoutSection.style.cssText =
            'margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px';

        const layoutLabel = document.createElement('span');
        layoutLabel.className = 'section-practice-label';
        layoutLabel.textContent = 'LAYOUT';

        const layoutRow = document.createElement('div');
        layoutRow.className = 'section-practice-controls-row';
        layoutRow.style.marginTop = '4px';

        const pageBtn = document.createElement('button');
        pageBtn.type = 'button';
        pageBtn.textContent = 'Page';
        pageBtn.title = 'Vertical page layout';
        pageBtn.className = btnCls;
        pageBtn.addEventListener('click', () => _svSetLayout(false));

        const horizBtn = document.createElement('button');
        horizBtn.type = 'button';
        horizBtn.textContent = 'Horiz';
        horizBtn.title = 'Horizontal scroll layout';
        horizBtn.className = btnCls;
        horizBtn.addEventListener('click', () => _svSetLayout(true));

        _svLayoutPageBtn  = pageBtn;
        _svLayoutHorizBtn = horizBtn;

        // Sync initial visual state.
        pageBtn.style.opacity    = _svLayoutIsHoriz ? '0.7' : '1';
        pageBtn.style.boxShadow  = _svLayoutIsHoriz ? '' : '0 0 0 1px #22c55e';
        horizBtn.style.opacity   = _svLayoutIsHoriz ? '1' : '0.7';
        horizBtn.style.boxShadow = _svLayoutIsHoriz ? '0 0 0 1px #22c55e' : '';

        layoutRow.appendChild(pageBtn);
        layoutRow.appendChild(horizBtn);
        layoutSection.appendChild(layoutLabel);
        layoutSection.appendChild(layoutRow);

        // ── ZOOM section ──────────────────────────────────────────
        const zoomSection = document.createElement('div');
        zoomSection.style.cssText =
            'margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px';

        const zoomLabel = document.createElement('span');
        zoomLabel.className = 'section-practice-label';
        zoomLabel.textContent = 'ZOOM';

        const zoomRow = document.createElement('div');
        zoomRow.className = 'section-practice-controls-row';
        zoomRow.style.cssText = 'margin-top:4px;justify-content:center;gap:6px';

        const minusBtn = document.createElement('button');
        minusBtn.type = 'button';
        minusBtn.textContent = '−';
        minusBtn.title = 'Zoom out';
        minusBtn.className = btnCls;
        minusBtn.addEventListener('click', () => _svSetScale(_svScale - 0.05));

        const zoomPct = document.createElement('span');
        zoomPct.style.cssText = 'min-width:2.5em;text-align:center;display:inline-block;font-size:.8rem';
        zoomPct.textContent = Math.round(_svScale * 100) + '%';

        const plusBtn = document.createElement('button');
        plusBtn.type = 'button';
        plusBtn.textContent = '+';
        plusBtn.title = 'Zoom in';
        plusBtn.className = btnCls;
        plusBtn.addEventListener('click', () => _svSetScale(_svScale + 0.05));

        const resetWrap = document.createElement('div');
        resetWrap.style.cssText = 'text-align:center;margin-top:3px';
        const resetLink = document.createElement('button');
        resetLink.type = 'button';
        resetLink.textContent = 'reset';
        resetLink.style.cssText =
            'background:none;border:none;color:rgba(255,255,255,0.4);font-size:.7rem;cursor:pointer;text-decoration:underline;padding:0';
        resetLink.addEventListener('click', () => _svSetScale(1.0));
        resetWrap.appendChild(resetLink);

        _svZoomLabel    = zoomPct;
        _svZoomMinusBtn = minusBtn;
        _svZoomPlusBtn  = plusBtn;

        // Sync initial disabled state.
        minusBtn.disabled = _svScale <= 0.5;
        plusBtn.disabled  = _svScale >= 2.0;

        zoomRow.appendChild(minusBtn);
        zoomRow.appendChild(zoomPct);
        zoomRow.appendChild(plusBtn);
        zoomSection.appendChild(zoomLabel);
        zoomSection.appendChild(zoomRow);
        zoomSection.appendChild(resetWrap);

        popover.appendChild(explorerSection);
        popover.appendChild(layoutSection);
        popover.appendChild(zoomSection);

        // ── Toggle popover on pill click ───────────────────────────
        pill.addEventListener('click', () => {
            const open = popover.style.display !== 'none';
            if (open) {
                popover.style.display = 'none';
                pill.setAttribute('aria-expanded', 'false');
                if (_svPopoverDeferTimer) { clearTimeout(_svPopoverDeferTimer); _svPopoverDeferTimer = null; }
                if (_svPopoverCloseHandler) {
                    document.removeEventListener('mousedown', _svPopoverCloseHandler, true);
                    _svPopoverCloseHandler = null;
                }
            } else {
                popover.style.display = 'block';
                // Clamp popover height to what fits on screen. vh units
                // include browser chrome (address bar etc.) so always use
                // window.innerHeight (the actual visible viewport).
                const viewH = window.innerHeight;
                if (v3Popover) {
                    // position:absolute, opens rightward from wrap.
                    const wrapRect = wrap.getBoundingClientRect();
                    popover.style.maxHeight = Math.max(120, viewH - wrapRect.top - 8) + 'px';
                } else {
                    // position:fixed, always open upward from the pill.
                    const btnRect = pill.getBoundingClientRect();
                    popover.style.bottom    = (viewH - btnRect.top + 6) + 'px';
                    popover.style.top       = '';
                    popover.style.maxHeight = Math.max(120, btnRect.top - 14) + 'px';
                }
                pill.setAttribute('aria-expanded', 'true');
                _svPopoverCloseHandler = (e) => {
                    if (!wrap.contains(e.target)) {
                        popover.style.display = 'none';
                        pill.setAttribute('aria-expanded', 'false');
                        document.removeEventListener('mousedown', _svPopoverCloseHandler, true);
                        _svPopoverCloseHandler = null;
                    }
                };
                // Defer one tick so the triggering click doesn't immediately close.
                _svPopoverDeferTimer = setTimeout(() => {
                    _svPopoverDeferTimer = null;
                    if (_svPopoverCloseHandler) {
                        document.addEventListener('mousedown', _svPopoverCloseHandler, true);
                    }
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
            // Prepend so the pill appears above #player-controls in the
            // footer, not below it. insertBefore with firstChild works even
            // when the footer is empty (firstChild is null → appendChild).
            footer.insertBefore(wrap, footer.firstChild);
        }
        _svPillWrap = wrap;
    }

    function _svRemovePill() {
        if (_svPillRetryTimer) { clearTimeout(_svPillRetryTimer); _svPillRetryTimer = null; }
        if (_svSlotObserver)   { _svSlotObserver.disconnect(); _svSlotObserver = null; }
        // Tear down the popover outside-click handler if the pill is
        // removed (teardown/destroy) while the popover is still open —
        // otherwise the document-level capture listener survives and pins
        // the detached DOM.
        if (_svPopoverDeferTimer) { clearTimeout(_svPopoverDeferTimer); _svPopoverDeferTimer = null; }
        if (_svPopoverCloseHandler) {
            document.removeEventListener('mousedown', _svPopoverCloseHandler, true);
            _svPopoverCloseHandler = null;
        }
        _svPillRetries = 0;
        if (_svPillWrap) {
            _svPillWrap.remove();
            _svPillWrap = null;
        }
        _svLayoutPageBtn  = null;
        _svLayoutHorizBtn = null;
        _svZoomLabel      = null;
        _svZoomMinusBtn   = null;
        _svZoomPlusBtn    = null;
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

    // ── alphaTab init ──────────────────────────────────────────────

    async function _svInitAlphaTab(myToken) {
        const c = _svCreateContainer();
        if (!c) return;

        if (_svApi) {
            try { _svApi.destroy(); } catch (_) {}
            _svApi = null;
        }
        _svApiReady = false;
        _svAtBeats  = [];
        _svLastBeat = null;
        if (_svAtMount) _svAtMount.innerHTML = '';

        await _loadAlphaTab();
        if (_svInitToken !== myToken) return;

        _svApi = new alphaTab.AlphaTabApi(_svAtMount, {
            core: {
                fontDirectory:     ALPHATAB_CDN_BASE + '/font/',
                includeNoteBounds: true,   // needed for boundsLookup marker
            },
            display: {
                // Read the pill's persisted layout/zoom prefs at init time.
                layoutMode:   _svLayoutIsHoriz
                    ? alphaTab.LayoutMode.Horizontal
                    : alphaTab.LayoutMode.Page,
                scale:        _svScale,
                staveProfile: alphaTab.StaveProfile
                    ? alphaTab.StaveProfile.Score
                    : 2,   // Score-only: no tablature staff
            },
            player: {
                // No alphaTab synth: the host owns audio (OGG). Disabling
                // the player drops the soundfont CDN download entirely and
                // removes the player-ready dependency (same as tabview).
                enablePlayer: false,
                enableCursor: false,   // we draw our own marker
            },
        });

        // ── Score loaded ─────────────────────────────────────────
        _svApi.scoreLoaded.on((score) => {
            if (_svInitToken !== myToken) return;
            _svAtBeats  = _svBuildBeatTimeline(score);
            _svLastBeat = null;
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

            // Re-place marker and loop overlay after each layout (boundsLookup
            // is freshly valid).
            _svUpdateMarker();
            _svUpdateLoopOverlay(_svLoopStartBeat, _svLoopEndBeat);
        });

        // ── alphaTab error ────────────────────────────────────────
        _svApi.error.on((e) => {
            if (_svInitToken !== myToken) return;
            console.error('[staffview] alphaTab error:', e);
            const failedFile = _svCurrentFile || _svLoadingFile;
            const failedArr  = _svCurrentArr  != null ? _svCurrentArr : _svLoadingArr;
            _svApiReady    = false;
            _svCurrentFile = null;
            _svCurrentArr  = null;
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

        // Register platform loop listeners for the full session lifetime.
        // loop-cleared: hide the overlay when the platform clears the loop
        // (regardless of who set it). loop-set / loop:restart: mirror a
        // loop set through the platform's own native controls (or a
        // restored saved loop) onto our score overlay — without this, the
        // overlay only ever reflects loops WE set via drag.
        if (window.feedBack && typeof window.feedBack.on === 'function') {
            if (_svLoopClearedHandler) {
                window.feedBack.off('playback:loop-cleared', _svLoopClearedHandler);
            }
            _svLoopClearedHandler = () => {
                if (_svInitToken !== myToken) return;
                _svOwnsOggLoop   = false;
                _svLoopStartBeat = null;
                _svLoopEndBeat   = null;
                _svHideLoopOverlay();
            };
            window.feedBack.on('playback:loop-cleared', _svLoopClearedHandler);

            if (_svLoopSetHandler) {
                window.feedBack.off('playback:loop-set', _svLoopSetHandler);
                window.feedBack.off('loop:restart',      _svLoopSetHandler);
            }
            _svLoopSetHandler = (ev) => {
                if (_svInitToken !== myToken) return;
                // window.feedBack events are DOM CustomEvents — data lives
                // in ev.detail. _svParseLoopEventDetail normalizes the two
                // possible shapes (see its own doc comment).
                const loop = _svParseLoopEventDetail(ev && ev.detail);
                if (!loop) return;
                const beatA = _svTimeToNearestBeat(loop.startTime);
                const beatB = _svTimeToNearestBeat(loop.endTime);
                if (!beatA || !beatB) return;
                _svLoopStartBeat = beatA;
                _svLoopEndBeat   = beatB;
                _svUpdateLoopOverlay(beatA, beatB);
            };
            window.feedBack.on('playback:loop-set', _svLoopSetHandler);
            window.feedBack.on('loop:restart',      _svLoopSetHandler);
        }

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

    // Converts a beat's tick to seconds via _svLatestBeats.
    // _svSyncCursor maps bundle.beats[i].time → tick via tick = (i + frac) * 960;
    // invert that: beatIndex = tick / 960, interpolate between adjacent entries.
    // Falls back to a score-tempo BPM approximation when beat data is not
    // loaded yet (wrong for tempo-varying songs, but better than no seek).
    function _svBeatToSeconds(beat) {
        const tick = typeof beat.absoluteDisplayStart === 'number'
            ? beat.absoluteDisplayStart
            : (typeof beat.absolutePlaybackStart === 'number'
                ? beat.absolutePlaybackStart : null);
        if (tick === null) return null;
        if (_svLatestBeats && _svLatestBeats.length >= 2) {
            const beatIdx = tick / 960;
            const i       = Math.floor(beatIdx);
            const frac    = beatIdx - i;
            if (i >= 0 && i < _svLatestBeats.length) {
                const t0 = _svLatestBeats[i].time;
                if (i + 1 < _svLatestBeats.length) {
                    return t0 + frac * (_svLatestBeats[i + 1].time - t0);
                }
                return t0;
            }
        }
        try {
            const score = _svApi && _svApi.score;
            const bpm   = (score && score.tempo) ? score.tempo : 120;
            return tick / ((bpm / 60) * 960);
        } catch (_) { return null; }
    }

    // ── Cursor sync ────────────────────────────────────────────────
    // Maps bundle.currentTime → MIDI ticks via the bundle.beats stream.

    function _svSyncCursor(currentTime) {
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
        if (_svMarkerRefreshTimer) { clearInterval(_svMarkerRefreshTimer); _svMarkerRefreshTimer = null; }
        _svTooltipDismissAll();
        _svTooltip     = null;
        _svLastTapTime = 0;
        _svApiReady      = false;
        _svLastTick      = -1;
        _svLastBeat      = null;
        _svAtBeats       = [];
        _svLatestBeats   = null;
        _svCurrentFile   = null;
        _svCurrentArr    = null;
        _svLoadingFile   = null;
        _svLoadingArr    = null;
        _svFailedFile    = null;
        _svFailedArr     = null;
        _svInfo          = null;
        _svMeasures      = [];
        _svNotationReady = false;
        _svRendered      = false;

        // Cancel any in-flight drag gesture.
        if (_svDragCleanup) { _svDragCleanup(); _svDragCleanup = null; }
        _svDragArmed = false; _svDragActive = false; _svDragBeat = null;

        // Clear a loop WE set and hide the overlay (_svClearLoop() is a
        // no-op on the platform side if the platform's own controls set the
        // current loop — _svOwnsOggLoop stays false in that case).
        _svClearLoop();

        if (window.feedBack && typeof window.feedBack.off === 'function') {
            if (_svLoopClearedHandler) window.feedBack.off('playback:loop-cleared', _svLoopClearedHandler);
            if (_svLoopSetHandler) {
                window.feedBack.off('playback:loop-set', _svLoopSetHandler);
                window.feedBack.off('loop:restart',      _svLoopSetHandler);
            }
        }
        _svLoopClearedHandler = null;
        _svLoopSetHandler     = null;

        _svCloseWs();

        if (_svApi) {
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

// The viz picker looks up window.feedBackViz_<id> — no other name is
// consumed anywhere in core or in other plugins, so this is the sole
// registration (the old slopsmithViz_staffview name has been dropped).
window.feedBackViz_staffview = createFactory;

// Auto-activates when the active arrangement carries notation data.
// songInfo.has_notation is set by server.py from LoadedSloppak.notation_by_id.
window.feedBackViz_staffview.matchesArrangement = function (songInfo) {
    return !!(songInfo && songInfo.has_notation);
};

})();
