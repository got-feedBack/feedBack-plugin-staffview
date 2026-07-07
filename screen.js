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
//   - MIDI input via the core midi-input capability domain
//     (window.feedBack.midiInput), mirroring plugins/keys_highway_3d's
//     connection pattern. Note-on/off is judged against the loaded score
//     and reported through the core note-detection domain (register-
//     provider once, open-binding per chart, reportHit/reportMiss) —
//     staffview owns judgment, the domain only carries the result.
//   - Monitor synth (WebAudioFont, own CDN) plays back the connected MIDI
//     keyboard; a mixer fader and pill Sound/Volume controls tune it
//
// Module-scope singletons:
//   - alphaTab CDN load promise (one <script> per page)
//   - _svFilename — captured from playSong wrap + arrangement:changed
//   - _nextInstanceId — monotonic DOM id suffix
//   - MIDI domain session (one per tab; every instance, including
//     splitscreen panels, shares it — events route to the focused one)

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
const _SV_STORE_LAYOUT   = 'staffview_layout';
const _SV_STORE_SCALE    = 'staffview_scale';
const _SV_STORE_MIDI_PICK = 'staffview_midi_pick';   // JSON {id,name,key}
const _SV_STORE_MIDI_CH   = 'staffview_midi_ch';

// Hit/miss judgment tolerance — ±100ms, matches keys_highway_3d.
const HIT_TOLERANCE_S = 0.1;

// Note-detection provider id (capabilities domain).
const ND_PROVIDER_ID = 'staffview-midi';

// Loopback / passthrough MIDI port names to skip when auto-connecting —
// mirrors the core midi-input domain's own built-in Web-MIDI provider
// filter, kept here too since a saved pick predating that filter could
// still resolve to one.
const _SV_MIDI_BLOCKLIST_RE = /midi through|^thru\b|^iac\b/i;

const _SV_STORE_SYNTH_INST = 'staffview_synth_inst';
const _SV_STORE_SYNTH_VOL  = 'staffview_synth_vol';
const _SV_STORE_PREROLL    = 'staffview_preroll';

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

// ═══════════════════════════════════════════════════════════════════════
// MIDI input (core midi-input capability domain — window.feedBack.midiInput)
// ═══════════════════════════════════════════════════════════════════════
// One shared domain session per tab; every staffview instance (splitscreen
// panels included) routes through it. Events are delivered only to the
// currently-FOCUSED instance (_svActiveInst) — in splitscreen that tracks
// panel focus via the splitscreen plugin's onFocusChange/isCanvasFocused;
// in the main player there is only ever one panel, so it's always focused.
// Mirrors plugins/keys_highway_3d's connection pattern (the piano-effort's
// established contract) rather than staffview's own pre-domain code, which
// used raw requestMIDIAccess and didn't need the async-race guards below.

let _svMidiReady        = false;  // discover() has succeeded at least once
let _svMidiInitInFlight = null;   // in-flight discover() promise, deduped
let _svMidiStateSub     = false;  // subscribed to midi-input:sources-changed
let _svMidiConnectSeq   = 0;      // generation guard for async _svMidiConnect races
let _svMidiHandle       = null;   // live session handle (addListener/removeListener)
let _svMidiListener     = null;   // bound listener currently registered on the handle
let _svMidiInput        = null;   // selected source descriptor { id, name, key }
let _svMidiActive       = false;  // true once at least one instance has "resumed" MIDI
let _svActiveInst       = null;   // factory instance currently receiving MIDI events
const _svInstances      = new Set();

function _svMi() {
    const m = window.feedBack && window.feedBack.midiInput;
    return (m && m.version === 1) ? m : null;
}

// Domain sources shaped like the old MIDIInput list: { id, name, key }.
function _svMidiSources() {
    const mi = _svMi();
    if (!mi) return [];
    return mi.listSources().map(s => ({ id: s.sourceId, name: s.label, key: s.logicalSourceKey }));
}

function _svMidiNotifyDeviceListChanged() {
    const inputs = _svMidiSources();
    const selects = document.querySelectorAll('.sv-midi-select');
    for (const sel of selects) {
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.key || inp.id;
            opt.textContent = inp.name || inp.id || 'Unknown';
            sel.appendChild(opt);
        }
        sel.value = _svMidiInput ? (_svMidiInput.key || _svMidiInput.id) : '';
    }
}

// Detach the live listener + release the domain session (does NOT clear
// _svMidiReady — a later reconnect should not re-prompt for permission).
function _svMidiDetach() {
    // Invalidate any in-flight _svMidiConnect open: a detach driven by
    // device removal (sources-changed) or an opt-out must supersede a
    // pending open so it can't resume and install a handle for a now-gone
    // source.
    _svMidiConnectSeq += 1;
    if (_svMidiHandle && _svMidiListener) {
        try { _svMidiHandle.removeListener(_svMidiListener); } catch (_) {}
    }
    const mi = _svMi();
    if (mi && _svMidiInput) {
        try { mi.close({ requester: PLUGIN_ID, logicalSourceKey: _svMidiInput.key || ('web-midi::' + _svMidiInput.id) }); }
        catch (_) {}
    }
    _svMidiHandle   = null;
    _svMidiListener = null;
    _svMidiInput    = null;
}

function _svReadSavedMidiPick() {
    try {
        const raw = _svReadStore(_SV_STORE_MIDI_PICK);
        if (raw) {
            const obj = JSON.parse(raw);
            if (obj && typeof obj === 'object') {
                return { id: String(obj.id || ''), name: String(obj.name || ''), key: String(obj.key || '') };
            }
        }
    } catch (_) {}
    return null;
}

function _svWriteSavedMidiPick(id, name, key) {
    _svSaveStore(_SV_STORE_MIDI_PICK, JSON.stringify({ id: id || '', name: name || '', key: key || '' }));
}

// allowFallback=false (recovery after sources-changed) never substitutes a
// different device for a currently-absent saved pick — a transient unplug
// must not silently reassign the user's chosen input; allowFallback=true
// (first connect) picks the first non-loopback device when there's no
// saved pick at all.
function _svMidiAutoConnect(allowFallback) {
    if (allowFallback === undefined) allowFallback = true;
    const inputs = _svMidiSources();
    if (!inputs.length) return;
    const saved = _svReadSavedMidiPick();
    if (saved && saved.id === '' && saved.name === '') return;   // explicit "None" opt-out
    let target = null;
    if (saved && saved.key)  target = inputs.find(i => i.key === saved.key) || null;
    if (!target && saved && saved.id) target = inputs.find(i => i.id === saved.id) || null;
    if (!target && saved && saved.name) {
        const n = saved.name.toLowerCase();
        target = inputs.find(i => (i.name || '').toLowerCase() === n) || null;
    }
    if (target && _SV_MIDI_BLOCKLIST_RE.test(target.name || '')) target = null;
    if (!target) {
        const hasSavedPick = !!(saved && (saved.key || saved.id || saved.name));
        if (!allowFallback && hasSavedPick) return;
        target = inputs.find(i => !_SV_MIDI_BLOCKLIST_RE.test(i.name || '')) || inputs[0];
    }
    _svMidiConnect(target.id, target.name, target.key);
}

async function _svMidiConnect(id, name, key) {
    // Capture our generation AFTER _svMidiDetach()'s own bump, so a later
    // detach (device removal / new connect / opt-out) reliably supersedes us.
    _svMidiDetach();
    const myGen = ++_svMidiConnectSeq;
    for (const inst of _svInstances) {
        if (inst && typeof inst._releaseAllHeld === 'function') inst._releaseAllHeld();
    }
    _svWriteSavedMidiPick(id || '', name || '', key || '');
    const mi = _svMi();
    if ((id || key) && mi) {
        const src = (key && _svMidiSources().find(s => s.key === key))
            || (id && _svMidiSources().find(s => s.id === id))
            || null;
        if (src) {
            const lkey = src.key || ('web-midi::' + src.id);
            _svMidiInput = { id: src.id, name: src.name, key: lkey };
            if (_svInstances.size === 0) { _svMidiNotifyDeviceListChanged(); return; }
            try {
                await mi.select(lkey);
                const res = await mi.open({ requester: PLUGIN_ID, logicalSourceKey: lkey });
                // A newer _svMidiConnect (device switch / None / replug) ran
                // while we awaited open — discard this stale session.
                if (myGen !== _svMidiConnectSeq) {
                    if (!_svMidiInput || _svMidiInput.key !== lkey) {
                        try { mi.close({ requester: PLUGIN_ID, logicalSourceKey: lkey }); } catch (_) {}
                    }
                    return;
                }
                if (res && res.handle) {
                    _svMidiHandle = res.handle;
                    // The domain handle delivers raw MIDI data; adapt to the
                    // old MIDIMessageEvent shape so _svMidiOnMessage is unchanged.
                    _svMidiListener = (data) => _svMidiOnMessage({ data });
                    if (_svMidiActive) _svMidiHandle.addListener(_svMidiListener);
                } else {
                    _svMidiInput = null;
                }
            } catch (e) {
                console.warn('[staffview] MIDI open failed:', e);
                if (myGen === _svMidiConnectSeq) _svMidiInput = null;
            }
        }
    }
    _svMidiNotifyDeviceListChanged();
}

// Lazily discovers MIDI access (permission boundary) at most once per page;
// safe to call from every instance's init() — a repeated call with no live
// session just re-runs auto-connect.
function _svMidiInit() {
    if (_svMidiReady) {
        if (!_svMidiHandle) _svMidiAutoConnect();
        return Promise.resolve();
    }
    if (_svMidiInitInFlight) return _svMidiInitInFlight;
    const mi = _svMi();
    if (!mi) return Promise.resolve();
    _svMidiInitInFlight = (async () => {
        try {
            const r = await mi.discover();   // permission boundary (requestMIDIAccess, in core)
            if (!r || r.outcome !== 'handled') return;   // denied/unavailable must not latch
            _svMidiReady = true;
            if (!_svMidiStateSub && window.feedBack && typeof window.feedBack.on === 'function') {
                _svMidiStateSub = true;
                window.feedBack.on('midi-input:sources-changed', () => {
                    _svMidiNotifyDeviceListChanged();
                    if (!_svMidiInput) _svMidiAutoConnect(false);   // recovery: saved device only
                });
            }
            _svMidiAutoConnect();
            _svMidiNotifyDeviceListChanged();
        } catch (e) {
            console.warn('[staffview] MIDI access denied:', e);
        } finally {
            _svMidiInitInFlight = null;
        }
    })();
    return _svMidiInitInFlight;
}

// Idempotent: a second live instance (splitscreen) calls this while already
// active. The domain handle's addListener is Set-backed, but don't rely on
// the provider de-duping — re-adding here could double-deliver one MIDI
// note to the focused instance and score a hit plus a duplicate miss.
function _svMidiResume() {
    if (_svMidiActive) return;
    _svMidiActive = true;
    if (_svMidiHandle && _svMidiListener) {
        try { _svMidiHandle.addListener(_svMidiListener); } catch (_) {}
    }
}

// Called when the LAST live instance is torn down: fully release the
// shared domain session (not just the listener) so the device/provider
// session isn't held open after every staffview instance is gone. Re-mount
// auto-connects from the saved pick; _svMidiReady is intentionally left
// latched so that doesn't re-prompt for permission.
function _svMidiReleaseSession() {
    _svMidiActive = false;
    _svMidiDetach();
}

function _svMidiOnMessage(e) {
    if (!_svActiveInst) return;
    const savedCh = parseInt(_svReadStore(_SV_STORE_MIDI_CH) || '-1', 10);
    const msg = _svParseMidiMessage(e.data, savedCh);
    if (!msg) return;
    if (msg.type === 'noteOn') {
        _svActiveInst._handleNoteOn(msg.note, msg.velocity);
    } else if (msg.type === 'noteOff') {
        _svActiveInst._handleNoteOff(msg.note);
    } else if (msg.type === 'sustain') {
        _svActiveInst._handleSustain(msg.down);
    }
}

// Extended splitscreen check — validates the full surface needed for MIDI
// focus routing (which panel receives MIDI events). Falls back gracefully
// (main-player fast-path — always focused) if splitscreen lacks the
// onFocusChange/isCanvasFocused surface.
function _ssActiveFull() {
    const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    return typeof ss.panelChromeFor  === 'function'
        && typeof ss.isCanvasFocused === 'function'
        && typeof ss.onFocusChange   === 'function'
        && typeof ss.offFocusChange  === 'function';
}

function _ssIsCanvasFocused(canvas) {
    if (!_ssActiveFull()) return true;
    const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
    return !!(ss && typeof ss.isCanvasFocused === 'function' && ss.isCanvasFocused(canvas));
}

// ═══════════════════════════════════════════════════════════════════════
// notedetect coexistence — suppress the generic note_detect plugin's
// default singleton while a staffview instance is active (staffview owns
// its own MIDI-based note detection over the same domain).
// ═══════════════════════════════════════════════════════════════════════

function _svSuppressNoteDetect(on) {
    const api = window.createNoteDetector;
    if (!api || typeof api.setDefaultSuppressed !== 'function') return;
    if (on) {
        api.setDefaultSuppressed(true);
    } else if (_svInstances.size === 0) {
        api.setDefaultSuppressed(false);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Note-detection capability (core domain) — registration + reporting
// ═══════════════════════════════════════════════════════════════════════
// staffview registers once as a 'midi' provider (idempotent across
// instances/song loads), then each instance opens its own context-scoped
// binding per chart load (closed on song switch / teardown) — mirrors
// plugins/keys_highway_3d's _ndEnsureProvider / open-binding pattern.

let _svNdProviderRegistered = false;

function _svCapsApi() {
    const c = window.feedBack && window.feedBack.capabilities;
    return (c && c.version === 1 && typeof c.command === 'function') ? c : null;
}

async function _svCapCommand(domain, name, payload, reason) {
    const caps = _svCapsApi();
    if (!caps) return null;
    try {
        const r = await caps.command(domain, name, {
            requester: PLUGIN_ID,
            source:    PLUGIN_ID,
            origin:    'system',
            reason:    reason || ('Staff View ' + domain + '.' + name),
            payload:   payload || {},
        });
        return (r && r.outcome === 'handled') ? (r.payload || {}) : null;
    } catch (_) { return null; }
}

async function _svNdEnsureProvider() {
    if (_svNdProviderRegistered) return;
    const p = await _svCapCommand('note-detection', 'register-provider', {
        providerId: ND_PROVIDER_ID,
        label:      'Staff View MIDI',
        kind:       'midi',
        primitives: ['verify.target'],
    }, 'Register the Staff View MIDI note-detection provider');
    if (p) _svNdProviderRegistered = true;
}

// Called when the LAST live instance is torn down — mirrors
// _svMidiReleaseSession's "only the last one out unregisters" symmetry, so
// the provider stays registered as long as any staffview instance (e.g. a
// splitscreen sibling) is still alive.
async function _svNdUnregisterProvider() {
    if (!_svNdProviderRegistered) return;
    await _svCapCommand('note-detection', 'unregister-provider', {
        providerId: ND_PROVIDER_ID,
    }, 'Unregister the Staff View MIDI note-detection provider');
    _svNdProviderRegistered = false;
}

// Hit/miss observability events — consumers own judgment, the domain only
// carries the result (spec 009 doctrine).
function _svNdReport(hit, midi, bindingId) {
    const nd = window.feedBack && window.feedBack.noteDetection;
    if (!nd || nd.version !== 1) return;
    try {
        (hit ? nd.reportHit : nd.reportMiss)({
            bindingId: bindingId || null,
            providerId: ND_PROVIDER_ID,
            midi,
            hit,
        });
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont monitor synth (module-level — one AudioContext per tab)
// ═══════════════════════════════════════════════════════════════════════
// Lets you hear the MIDI keyboard while playing along with the notation —
// core has no keyboard-tone synth of its own, so this loads WebAudioFont
// from its own CDN (surikov.github.io) as a second third-party runtime
// dependency alongside alphaTab. Flagged in the PR body as a candidate for
// future core-hosted keyboard tones.

const WAF_BASE       = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF         = 'JCLive_sf2_file';

const _SV_INSTRUMENTS = [
    { name: 'Grand Piano',    gm: 0  },
    { name: 'Electric Piano', gm: 4  },
    { name: 'Honky-tonk',     gm: 3  },
    { name: 'Organ',          gm: 19 },
    { name: 'Strings',        gm: 48 },
    { name: 'Synth Lead',     gm: 80 },
    { name: 'Synth Pad',      gm: 88 },
    { name: 'Harpsichord',    gm: 6  },
    { name: 'Vibraphone',     gm: 11 },
    { name: 'Music Box',      gm: 10 },
];

// Pure — the WebAudioFont data-file naming convention (GM program number
// zero-padded *10, one <script> per instrument, each defining a global
// `_tone_<file>` preset variable).
function _svWafFile(gm) { return String(gm * 10).padStart(4, '0') + '_' + WAF_SF; }
function _svWafVar(gm)  { return '_tone_' + _svWafFile(gm); }
function _svWafUrl(gm)  { return WAF_BASE + _svWafFile(gm) + '.js'; }

function _svLoadWafScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('[staffview] Failed to load ' + url));
        document.head.appendChild(s);
    });
}

let _svAudioCtx        = null;
let _svSynthGain       = null;
let _svSynthPlayer     = null;
let _svSynthPreset     = null;
let _svWafScriptLoaded = false;
const _svNoteEnvelopes = new Map();   // midi → WebAudioFont envelope handle
let _svSynthVolume        = parseFloat(_svReadStore(_SV_STORE_SYNTH_VOL) || '0.7');
let _svSynthInstrumentIdx = parseInt(_svReadStore(_SV_STORE_SYNTH_INST) || '0', 10);

// Lazily loads the WebAudioFontPlayer script + the saved instrument's sound
// data, then builds the AudioContext/gain/player chain. Safe to call
// repeatedly (no-op once _svSynthPlayer exists) — called from the first
// note-on so there's no unprompted AudioContext creation (autoplay policy)
// and no upfront cost for keyboards that are never played.
async function _svSynthInit() {
    if (_svSynthPlayer) return;
    try {
        if (!_svWafScriptLoaded) {
            await _svLoadWafScript(WAF_PLAYER_URL);
            _svWafScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;
        _svAudioCtx  = new (window.AudioContext || window.webkitAudioContext)();
        _svSynthGain = _svAudioCtx.createGain();
        _svSynthGain.gain.value = _svSynthVolume;
        _svSynthGain.connect(_svAudioCtx.destination);
        _svSynthPlayer = new WebAudioFontPlayer();
        await _svSynthLoadInstrument(_svSynthInstrumentIdx);
    } catch (e) {
        console.warn('[staffview] Synth init failed:', e);
    }
}

async function _svSynthLoadInstrument(idx) {
    const inst = _SV_INSTRUMENTS[idx];
    if (!inst || !_svSynthPlayer || !_svAudioCtx) return;
    const varName = _svWafVar(inst.gm);
    try {
        if (!window[varName]) await _svLoadWafScript(_svWafUrl(inst.gm));
        const preset = window[varName];
        if (preset) {
            _svSynthPlayer.adjustPreset(_svAudioCtx, preset);
            _svSynthPreset = preset;
        }
    } catch (e) {
        console.warn('[staffview] Failed to load instrument:', inst.name, e);
    }
}

// Browsers suspend a newly-created AudioContext until a user gesture; the
// MIDI note-on that triggers _svSynthInit() in the first place IS that
// gesture, so resume it every note-on (cheap no-op once running).
function _svSynthEnsureCtx() {
    if (_svAudioCtx && _svAudioCtx.state === 'suspended') _svAudioCtx.resume();
}

function _svSynthNoteOn(midi) {
    if (!_svSynthPlayer || !_svSynthPreset || !_svAudioCtx || !_svSynthGain) return;
    _svSynthEnsureCtx();
    const existing = _svNoteEnvelopes.get(midi);
    if (existing) { try { existing.cancel(); } catch (_) {} }
    try {
        // Duration 999s (effectively "until noteOff") — sustain is driven
        // by explicit cancel(), not the WebAudioFont library's own envelope.
        const envelope = _svSynthPlayer.queueWaveTable(
            _svAudioCtx, _svSynthGain, _svSynthPreset, 0, midi, 999, _svSynthVolume
        );
        _svNoteEnvelopes.set(midi, envelope);
    } catch (_) {}
}

function _svSynthNoteOff(midi) {
    const env = _svNoteEnvelopes.get(midi);
    if (env) {
        try { env.cancel(); } catch (_) {}
        _svNoteEnvelopes.delete(midi);
    }
}

function _svSynthReleaseAll() {
    for (const env of _svNoteEnvelopes.values()) {
        try { env.cancel(); } catch (_) {}
    }
    _svNoteEnvelopes.clear();
}

// ── Mixer fader (feedBack#87) ────────────────────────────────────────────

function _svRegisterFader() {
    const api = window.feedBack && window.feedBack.audio;
    if (!api || typeof api.registerFader !== 'function') return;
    api.registerFader({
        id:    'staffview_keyboard',
        label: 'Keyboard',
        min: 0, max: 1, step: 0.01,
        defaultValue: 0.7,
        getValue: () => _svSynthVolume,
        setValue: (v) => {
            _svSynthVolume = v;
            _svSaveStore(_SV_STORE_SYNTH_VOL, String(v));
            if (_svSynthGain) _svSynthGain.gain.value = v;
            // Keep every mounted pill's own volume slider in sync when the
            // value changes from the mixer side.
            document.querySelectorAll('.sv-vol-range').forEach(r => {
                r.value = String(Math.round(v * 100));
            });
        },
    });
}
if (window.feedBack && window.feedBack.audio) {
    _svRegisterFader();
} else {
    window.addEventListener('feedBack:audio:ready', _svRegisterFader, { once: true });
}

// Zoom clamp: 50%-200% in 5% steps. Pulled out of _svSetScale so the pure
// math is independently testable (tests/zoom.test.js).
function _svClampScale(value) {
    return Math.max(0.5, Math.min(2.0, Math.round(value * 20) / 20));
}

// Parses a raw 1-3 byte MIDI message into a normalized event, or null if
// it's not one of the three messages staffview cares about (or filtered
// out by the channel setting). savedCh is the user's saved channel
// preference: -1 means "All channels".
//   Note On  (0x9n, velocity > 0)                → { type: 'noteOn',  note, velocity }
//   Note Off (0x8n, or 0x9n with velocity === 0)  → { type: 'noteOff', note }
//   Sustain  (0xBn, controller 64 / CC64)         → { type: 'sustain', down }
function _svParseMidiMessage(data, savedCh) {
    if (!data || data.length < 2) return null;
    const status   = data[0];
    const note     = data[1];
    const velocity = data[2] || 0;
    const ch = status & 0x0F;
    if (savedCh >= 0 && ch !== savedCh) return null;
    const cmd = status & 0xF0;
    if (cmd === 0x90 && velocity > 0) return { type: 'noteOn', note, velocity };
    if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) return { type: 'noteOff', note };
    if (cmd === 0xB0 && note === 64) return { type: 'sustain', down: velocity >= 64 };
    return null;
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
// Core live-performance HUD repositioning (v3)
// ═══════════════════════════════════════════════════════════════════════
// Core's #v3-live-performance-hud lives in the top bar (#player-hud) — the
// right spot for falling-note vizs, but it overlaps the grand staff here.
// While a staffview view is actually showing notation we move it to the
// bottom-right, stacked just above our own per-hand score badge. The scope
// is driven by a class the plugin toggles on its own show/teardown triggers
// (NOT a CSS-only heuristic), so it can never affect other vizs; the move
// itself is one injected CSS rule. HUD only exists in v3, so v2/SS no-op.
const _svNotationShowing  = new Set();   // instances currently showing notation
let   _svHudStyleInjected = false;

function _svEnsureHudStyle() {
    if (_svHudStyleInjected) return;
    _svHudStyleInjected = true;
    const s = document.createElement('style');
    s.id = 'staffview-hud-reposition';
    // Our per-hand line lives inside this box (see _svHandAccEl), so the whole
    // scoreboard moves as one unit — just anchor it to the bottom-right, clear
    // of the grand staff and above the player controls.
    s.textContent =
        'html.staffview-notation-active #v3-live-performance-hud{' +
        'position:fixed;top:auto;bottom:96px;right:16px;left:auto;z-index:30;}';
    document.head.appendChild(s);
}

// Remove our injected per-hand line from core's HUD so it never lingers
// under another viz's HUD once staffview stops showing notation.
function _svRemoveHandAcc() {
    const el = document.getElementById('staffview-hand-acc');
    if (el && el.parentElement) el.parentElement.removeChild(el);
}

function _svSetNotationShowing(instance, on) {
    if (on) {
        if (!_isV3()) return;   // core HUD only exists in v3
        _svNotationShowing.add(instance);
    } else {
        _svNotationShowing.delete(instance);
    }
    const cls = document.documentElement.classList;
    if (_svNotationShowing.size > 0) {
        _svEnsureHudStyle();
        cls.add('staffview-notation-active');
    } else {
        cls.remove('staffview-notation-active');
        _svRemoveHandAcc();   // clean up our injected HUD line
    }
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

    // ── MIDI focus / lifecycle state ────────────────────────────────
    // Splitscreen can host multiple staffview panels; only the FOCUSED
    // one's _svActiveInst assignment receives routed MIDI events (module-
    // level _svUpdateFocusState / _ssIsCanvasFocused). The main player has
    // only one panel, so focus is always true there.
    let _svInstanceDestroyed = false;
    let _svIsFocused         = false;
    let _svFocusRegistered   = false;

    // ── MIDI held-note bookkeeping ───────────────────────────────────
    // Currently unused beyond _svReleaseAllHeld's no-op-without-a-synth
    // stub — kept as real Map/Set state (not deferred to a later PR)
    // because _handleNoteOff's sustain-hold semantics depend on it, and
    // the monitor synth PR will read/drive this same state rather than
    // introduce a parallel copy.
    const _svHeldNotes      = new Map();   // midi → velocity
    let _svSustainOn        = false;
    const _svSustainedNotes = new Set();

    // ── Judgment note lists and counters ────────────────────────────
    // Built from the loaded score (_svBuildJudgeLists) once alphaTab's
    // scoreLoaded fires. noteKey = staffIdx|barIdx|absStart|midi — stable
    // across re-layouts (page/horizontal toggle, zoom) since it doesn't
    // depend on rendered position.
    let _svJudgeNotesAll = null;   // [{midi,t,hand,noteKey}], sorted by t
    let _svJudgeNotesRH  = null;   // hand=0 (top staff) subset
    let _svJudgeNotesLH  = null;   // hand=1 (bottom staff) subset
    let _svHits = 0, _svMisses = 0, _svStreak = 0, _svBestStreak = 0;
    let _svHitsRH = 0, _svMissesRH = 0;   // hand 0 (top staff)
    let _svHitsLH = 0, _svMissesLH = 0;   // hand 1 (bottom staff)
    const _svHitNoteKeys = new Set();   // deduplicates per-note hit claims

    // ── LH/RH hand isolation ─────────────────────────────────────────
    let _svActiveHands = 'both';   // 'both' | 'rh' | 'lh'
    let _svHandRow      = null;
    let _svRhBtn        = null;
    let _svLhBtn        = null;

    // ── Study mode ──────────────────────────────────────────────────
    // Note-by-note gated practice: the OGG pauses at each gate (a beat's
    // required notes) and only resumes once they are all played on MIDI.
    let _svStudyMode         = false;
    let _svStudyGates        = [];     // [{gateTime, entries[]}] sorted by gateTime
    let _svStudyGateIdx      = 0;      // index of the current gate
    let _svStudyGateTime     = null;   // OGG seconds at which to pause; null = none
    const _svStudyChordHit   = new Set();   // noteKeys satisfied at the current gate
    let _svStudyBtnEl        = null;
    let _svStudyCountingDown = false;
    let _svStudyCountdownId  = null;
    let _svStudyAudioCtx     = null;   // metronome beeps; closed on teardown
    let _svStudySeekHandler  = null;   // 'seeked' listener for platform seeks
    const _svStudyWrongAttempts = new Map();   // gateIdx → Set<wrongMidi>

    // ── Global preroll ──────────────────────────────────────────────
    let _svPrerollEnabled  = _svReadStore(_SV_STORE_PREROLL) !== 'false';
    let _svPrerollResuming = false;   // true when audio.play() was our own call
    let _svWasAudioPaused  = null;    // null = unobserved; tracks pause→play edges

    // ── Miss-dot overlay ───────────────────────────────────────────
    // A persistent canvas (below the playback marker's z-index) sweeps
    // judge notes as playback passes their hit window and draws a small
    // red dot at any note that was never hit — a swept note counts as a
    // miss for the combined accuracy too, not just per-hand (without this
    // the denominator would only count wrong key-presses, inflating
    // accuracy for a chart the user simply skipped over).
    let _svMissCanvas    = null;
    let _svMissSweepIdx  = 0;
    let _svLastSweepTime = -1;   // for backward-seek detection
    const _svMissNotes      = new Set();   // noteKeys of swept-miss notes
    const _svMissEntryByKey = new Map();   // noteKey → judge-list entry

    // ── Note-detection binding (this instance's chart-scoped context) ──
    let _svNdBindingId = null;
    let _svNdLoadSeq    = 0;   // bumped per chart load; guards a stale
                               // open-binding response from a rapid song
                               // switch landing after the next chart is
                               // already active

    // ── Layout mode and zoom (persisted, read once at factory creation) ────
    // Stored as plain values so instance creation doesn't touch alphaTab
    // (not loaded yet) — applied to the AlphaTabApi settings in _svInitAlphaTab.
    let _svLayoutIsHoriz = _svReadStore(_SV_STORE_LAYOUT) === 'horizontal';
    let _svScale         = parseFloat(_svReadStore(_SV_STORE_SCALE) || '1.0');
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
        _svSuppressNoteDetect(true);

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

        // Miss-dot overlay canvas — below the marker's z-index so the
        // playback cursor still draws on top of it.
        const missCanvas = document.createElement('canvas');
        missCanvas.id = 'staffview-miss-' + _instanceId;
        missCanvas.style.cssText =
            'position:absolute;top:0;left:0;pointer-events:none;z-index:3;display:block';
        c.appendChild(missCanvas);

        mount.appendChild(c);
        _svContainer  = c;
        _svAtMount    = inner;
        _svMarker     = marker;
        _svMissCanvas = missCanvas;

        // ── Click-to-seek ─────────────────────────────────────────
        // mousedown on the score div: resolve the clicked position to a
        // beat tick via boundsLookup.getBeatAtPos(), then seek the OGG
        // audio element (currentTime) via the bundle.beats time stream.
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

            // Seek the OGG audio element.
            const secs = _svBeatToSeconds(beat);
            if (secs !== null) {
                const audio = document.getElementById('audio');
                if (audio) { try { audio.currentTime = secs; } catch (_) {} }
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
        _svResizeMissCanvas();
        _svRedrawAllMissDots();
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
            _svContainer  = null;
            _svAtMount    = null;
            _svMarker     = null;
            _svMissCanvas = null;
        }
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
        const selCls = _isV3()
            ? 'v3-pop-btn'
            : 'bg-dark-600 rounded-lg text-xs text-gray-300';

        // ── MIDI section ───────────────────────────────────────────
        // Device + channel picker. Always visible (not gated on a loaded
        // chart) so the user can set up their device ahead of time. The
        // device <select> is kept in sync by _svMidiNotifyDeviceListChanged
        // via its shared 'sv-midi-select' class — every mounted pill's
        // select updates together.
        const midiSection = document.createElement('div');

        const midiLabel = document.createElement('span');
        midiLabel.className = 'section-practice-label';
        midiLabel.textContent = 'MIDI';

        const midiRow = document.createElement('div');
        midiRow.className = 'section-practice-controls-row';
        midiRow.style.marginTop = '4px';

        const midiSel = document.createElement('select');
        midiSel.className = 'sv-midi-select ' + selCls;
        midiSel.title = 'MIDI input device';
        midiSel.style.flex = '1 1 auto';
        midiSel.style.minWidth = '0';
        const midiNoneOpt = document.createElement('option');
        midiNoneOpt.value = '';
        midiNoneOpt.textContent = 'None';
        midiSel.appendChild(midiNoneOpt);
        midiSel.addEventListener('change', () => {
            const key = midiSel.value;
            const src = _svMidiSources().find(s => (s.key || s.id) === key);
            _svMidiConnect(src ? src.id : '', src ? src.name : '', key);
        });

        const midiChSel = document.createElement('select');
        midiChSel.className = selCls;
        midiChSel.title = 'MIDI channel (All or 1-16)';
        midiChSel.style.marginLeft = '4px';
        const allOpt = document.createElement('option');
        allOpt.value = '-1';
        allOpt.textContent = 'All ch';
        midiChSel.appendChild(allOpt);
        for (let ch = 1; ch <= 16; ch++) {
            const o = document.createElement('option');
            o.value = String(ch - 1);
            o.textContent = 'Ch ' + ch;
            midiChSel.appendChild(o);
        }
        midiChSel.value = _svReadStore(_SV_STORE_MIDI_CH) || '-1';
        midiChSel.addEventListener('change', () => {
            _svSaveStore(_SV_STORE_MIDI_CH, midiChSel.value);
        });

        midiRow.appendChild(midiSel);
        midiRow.appendChild(midiChSel);
        midiSection.appendChild(midiLabel);
        midiSection.appendChild(midiRow);

        // ── Monitor synth — Sound + Volume rows ─────────────────────
        // Grouped visually inside the MIDI section since they only matter
        // once a MIDI device is connected.
        const soundRow = document.createElement('div');
        soundRow.className = 'section-practice-controls-row';
        soundRow.style.marginTop = '6px';

        const soundLabel = document.createElement('span');
        soundLabel.className = 'section-practice-label';
        soundLabel.textContent = 'Sound';
        soundLabel.style.cssText = 'margin-right:4px;font-size:10px;opacity:0.7;white-space:nowrap';

        const soundSel = document.createElement('select');
        soundSel.className = selCls;
        soundSel.title = 'Monitor synth instrument';
        _SV_INSTRUMENTS.forEach((inst, i) => {
            const o = document.createElement('option');
            o.value = String(i); o.textContent = inst.name;
            if (i === _svSynthInstrumentIdx) o.selected = true;
            soundSel.appendChild(o);
        });
        soundSel.addEventListener('change', () => {
            const idx = parseInt(soundSel.value, 10);
            _svSynthInstrumentIdx = idx;
            _svSaveStore(_SV_STORE_SYNTH_INST, String(idx));
            _svSynthLoadInstrument(idx);
        });

        soundRow.appendChild(soundLabel);
        soundRow.appendChild(soundSel);
        midiSection.appendChild(soundRow);

        const volRow = document.createElement('div');
        volRow.className = 'section-practice-controls-row';
        volRow.style.cssText = 'margin-top:6px;align-items:center;gap:6px';

        const volLabel = document.createElement('span');
        volLabel.className = 'section-practice-label';
        volLabel.textContent = 'Volume';
        volLabel.style.cssText = 'font-size:10px;opacity:0.7;white-space:nowrap';

        const volRange = document.createElement('input');
        volRange.type = 'range';
        volRange.min = '0';
        volRange.max = '100';
        volRange.className = 'sv-vol-range';
        volRange.value = String(Math.round(_svSynthVolume * 100));
        volRange.style.cssText = 'flex:1 1 auto;min-width:0;accent-color:#4080e0';
        volRange.addEventListener('input', () => {
            const v = parseInt(volRange.value, 10) / 100;
            _svSynthVolume = v;
            _svSaveStore(_SV_STORE_SYNTH_VOL, String(v));
            if (_svSynthGain) _svSynthGain.gain.value = v;
        });

        volRow.appendChild(volLabel);
        volRow.appendChild(volRange);
        midiSection.appendChild(volRow);

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

        // ── HAND section (LH/RH isolation) ────────────────────────
        // Hidden by default; shown only for grand-staff (≥2 staves) scores,
        // toggled in scoreLoaded. Clicking a hand isolates it (dims the other
        // staff + judges only that hand); clicking it again returns to Both.
        const handSection = document.createElement('div');
        handSection.style.cssText =
            'margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px;display:none';

        const handLabel = document.createElement('span');
        handLabel.className = 'section-practice-label';
        handLabel.textContent = 'HAND';

        const handRow = document.createElement('div');
        handRow.className = 'section-practice-controls-row';
        handRow.style.cssText = 'margin-top:4px;gap:6px';

        const rhBtn = document.createElement('button');
        rhBtn.type = 'button';
        rhBtn.textContent = 'RH';
        rhBtn.title = 'Right hand only — click again to reset to Both';
        rhBtn.className = btnCls;
        rhBtn.style.opacity = '0.7';
        rhBtn.addEventListener('click',
            () => _svSetActiveHands(_svActiveHands === 'rh' ? 'both' : 'rh'));

        const lhBtn = document.createElement('button');
        lhBtn.type = 'button';
        lhBtn.textContent = 'LH';
        lhBtn.title = 'Left hand only — click again to reset to Both';
        lhBtn.className = btnCls;
        lhBtn.style.opacity = '0.7';
        lhBtn.addEventListener('click',
            () => _svSetActiveHands(_svActiveHands === 'lh' ? 'both' : 'lh'));

        handRow.appendChild(rhBtn);
        handRow.appendChild(lhBtn);
        handSection.appendChild(handLabel);
        handSection.appendChild(handRow);

        _svHandRow = handSection;
        _svRhBtn   = rhBtn;
        _svLhBtn   = lhBtn;
        _svUpdateHandButtons();   // reflect current _svActiveHands

        // ── STUDY section (note-by-note gated practice) ────────────
        const studySection = document.createElement('div');
        studySection.style.cssText =
            'margin-top:8px;border-top:1px solid rgba(255,255,255,0.08);padding-top:8px';

        const studyLabel = document.createElement('span');
        studyLabel.className = 'section-practice-label';
        studyLabel.textContent = 'STUDY';

        const studyRow = document.createElement('div');
        studyRow.className = 'section-practice-controls-row';
        studyRow.style.marginTop = '4px';

        const studyBtn = document.createElement('button');
        studyBtn.type = 'button';
        studyBtn.textContent = 'Study mode';
        studyBtn.title = 'Play through the song note by note';
        studyBtn.className = btnCls;
        studyBtn.addEventListener('click',
            () => { if (_svStudyMode) _svStudyDeactivate(); else _svStudyActivate(); });
        _svStudyBtnEl = studyBtn;
        _svUpdateStudyBtn();   // reflect current _svStudyMode

        const studyDesc = document.createElement('div');
        studyDesc.textContent = 'Play through the song note by note';
        studyDesc.style.cssText = 'font-size:0.7em;color:rgba(255,255,255,0.4);margin-top:4px';

        studyRow.appendChild(studyBtn);
        studySection.appendChild(studyLabel);
        studySection.appendChild(studyRow);
        studySection.appendChild(studyDesc);

        // Preroll count-in toggle (persisted).
        const prerollRow = document.createElement('label');
        prerollRow.className = 'section-practice-controls-row';
        prerollRow.style.cssText = 'margin-top:6px;align-items:center;gap:6px;cursor:pointer';
        const prerollChk = document.createElement('input');
        prerollChk.type    = 'checkbox';
        prerollChk.checked = _svPrerollEnabled;
        prerollChk.addEventListener('change', () => {
            _svPrerollEnabled = prerollChk.checked;
            _svSaveStore(_SV_STORE_PREROLL, String(_svPrerollEnabled));
        });
        const prerollText = document.createElement('span');
        prerollText.className = 'section-practice-label';
        prerollText.textContent = 'Preroll count-in';
        prerollText.style.cssText = 'font-size:10px;opacity:0.7';
        prerollRow.appendChild(prerollChk);
        prerollRow.appendChild(prerollText);
        studySection.appendChild(prerollRow);

        popover.appendChild(midiSection);
        popover.appendChild(layoutSection);
        popover.appendChild(zoomSection);
        popover.appendChild(handSection);
        popover.appendChild(studySection);

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

        // Now that midiSel is actually attached to the document,
        // document.querySelectorAll('.sv-midi-select') inside
        // _svMidiNotifyDeviceListChanged can find it — populate it with
        // whatever the domain already knows (pill re-created mid-session,
        // e.g. splitscreen panel remount, or the device connected before
        // this pill existed) instead of waiting for the next
        // sources-changed event, which may never come if nothing changes
        // again this session.
        _svMidiNotifyDeviceListChanged();
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
        _svHandRow        = null;
        _svRhBtn          = null;
        _svLhBtn          = null;
        _svStudyBtnEl     = null;
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
            // A fresh chart starts un-isolated (Both) — the new render carries
            // no hand colouring, and a single-staff chart has no hands to split.
            _svActiveHands = 'both';
            _svUpdateHandButtons();
            _svBuildJudgeLists(score);
            // Show the HAND toggles only for grand-staff (≥2 staves) scores.
            if (_svHandRow) {
                const staves = score.tracks && score.tracks[0] && score.tracks[0].staves;
                _svHandRow.style.display = (staves && staves.length >= 2) ? '' : 'none';
            }
            const seq = _svNdLoadSeq;
            _svNdOpenBindingForChart(seq);
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
            // Notation is now on screen — pull core's top-bar HUD down out of
            // the way of the grand staff.
            _svSetNotationShowing(instance, true);

            _svFailedFile = null;
            _svFailedArr  = null;
            _svRemoveErrorBanner();

            // Re-place marker after each layout (boundsLookup is freshly valid).
            _svUpdateMarker();

            // Re-size and repaint the miss-dot overlay after each relayout.
            _svResizeMissCanvas();
            _svRedrawAllMissDots();
            // boundsLookup may not be populated yet on the first renderFinished;
            // if the canvas height is still 0, retry once on the next frame.
            if (_svMissCanvas && _svMissCanvas.height === 0) {
                requestAnimationFrame(() => {
                    if (_svInitToken !== myToken) return;
                    _svResizeMissCanvas();
                    _svRedrawAllMissDots();
                });
            }
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
            // Notation no longer on screen — restore core's HUD to the top bar.
            _svSetNotationShowing(instance, false);
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
        _svNdLoadSeq++;   // guards a stale open-binding response from a superseded chart load

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
        // In study mode the cursor is driven by _svStudySnapCursor (gate
        // position), not audio time — suppress here to avoid fighting snaps.
        if (_svStudyMode) return;
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

    // ── Focus state management ──────────────────────────────────────
    // instance is declared at the end of createFactory; closed over by
    // reference — only called after init() has run, by which point the
    // assignment below has already happened.

    function _svUpdateFocusState() {
        if (_svInstanceDestroyed || !_svHighwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_svHighwayCanvas);
        if (shouldFocus && !_svIsFocused) {
            _svIsFocused  = true;
            _svActiveInst = instance;   // eslint-disable-line no-use-before-define
        } else if (!shouldFocus && _svIsFocused) {
            _svIsFocused = false;
            _svReleaseAllHeld();
            if (_svActiveInst === instance) _svActiveInst = null;   // eslint-disable-line no-use-before-define
        }
    }

    function _svReleaseAllHeld() {
        _svSynthReleaseAll();
        _svHeldNotes.clear();
        _svSustainedNotes.clear();
        _svSustainOn = false;
    }

    // Thin wrappers so _handleNoteOn/_handleNoteOff read as "judge + sound"
    // rather than reaching into the module-level synth directly.
    function _svMonitorNoteOn(midi) {
        _svSynthInit();   // no-op once already initialised
        _svSynthNoteOn(midi);
    }
    function _svMonitorNoteOff(midi) { _svSynthNoteOff(midi); }

    function _svGetCurrentTime() {
        try {
            const audio = document.getElementById('audio');
            if (audio) return audio.currentTime;
        } catch (_) {}
        return null;
    }

    // ── Judgment note list builder ──────────────────────────────────
    // Walks score.tracks[0].staves to build per-hand and combined note
    // lists indexed by time. Called from scoreLoaded, after _svAtBeats is
    // built (_svBeatToSeconds needs it for songs without a full bundle.beats
    // stream yet).

    function _svBuildJudgeLists(score) {
        const all = [], rh = [], lh = [];
        try {
            const staves = score.tracks[0].staves;
            for (let si = 0; si < staves.length; si++) {
                for (const bar of (staves[si].bars || [])) {
                    for (const voice of (bar.voices || [])) {
                        for (const beat of (voice.beats || [])) {
                            const t = _svBeatToSeconds(beat);
                            if (t === null) continue;
                            const abs = typeof beat.absoluteDisplayStart === 'number'
                                ? beat.absoluteDisplayStart : 0;
                            for (let ni = 0; ni < (beat.notes || []).length; ni++) {
                                const note = beat.notes[ni];
                                if (note.isTieDestination) continue; // no new note-on expected
                                const midi = note.octave * 12 + note.tone;
                                if (midi < 0 || midi > 127) continue;
                                const entry = {
                                    midi, t, hand: si,
                                    noteKey: si + '|' + (bar.index || 0) + '|' + abs + '|' + midi,
                                    beat, noteIdx: ni,
                                };
                                all.push(entry);
                                if (si === 0) rh.push(entry);
                                else          lh.push(entry);
                            }
                        }
                    }
                }
            }
        } catch (_) {}
        all.sort((a, b) => a.t - b.t);
        rh.sort((a, b) => a.t - b.t);
        lh.sort((a, b) => a.t - b.t);
        _svJudgeNotesAll = all;
        _svJudgeNotesRH  = rh;
        _svJudgeNotesLH  = lh;
        _svMissEntryByKey.clear();
        for (const e of all) _svMissEntryByKey.set(e.noteKey, e);
        // Clean slate; also re-syncs the sweep past the current playback time
        // so notes already in the past when the chart loads are never
        // retroactively missed.
        _svResetJudgeState();
    }

    // Returns the MIDI range spanned by the loaded score's judge notes, or
    // null if there are none yet. Used as note-detection binding context.
    function _svJudgeMidiRange() {
        if (!_svJudgeNotesAll || !_svJudgeNotesAll.length) return null;
        let lo = 127, hi = 0;
        for (const e of _svJudgeNotesAll) {
            if (e.midi < lo) lo = e.midi;
            if (e.midi > hi) hi = e.midi;
        }
        return { activeLow: lo, activeHigh: hi };
    }

    // ── Hit/miss judgment ────────────────────────────────────────────
    // Returns the matched noteKey on hit (also recorded, to prevent
    // double-counting the same chart note), or null on miss. ±100ms
    // tolerance (HIT_TOLERANCE_S), matching keys_highway_3d.

    function _svJudgeHit(playedMidi, playedTime) {
        const notes = _svActiveHands === 'rh' ? _svJudgeNotesRH
                    : _svActiveHands === 'lh' ? _svJudgeNotesLH
                    : _svJudgeNotesAll;
        if (!notes || !notes.length) return null;
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            if (n.t > playedTime + HIT_TOLERANCE_S + 0.5) break;
            if (n.t < playedTime - HIT_TOLERANCE_S - 0.5) continue;
            if (n.midi === playedMidi
                    && Math.abs(n.t - playedTime) <= HIT_TOLERANCE_S
                    && !_svHitNoteKeys.has(n.noteKey)) {
                _svHitNoteKeys.add(n.noteKey);
                _svHits++;
                if (n.hand === 0) _svHitsRH++; else _svHitsLH++;
                _svStreak++;
                if (_svStreak > _svBestStreak) _svBestStreak = _svStreak;
                // Replay: a note previously swept-missed is being hit now —
                // erase its dot so the overlay reflects the successful retry.
                if (_svMissNotes.has(n.noteKey)) {
                    _svMissNotes.delete(n.noteKey);
                    _svRedrawAllMissDots();
                }
                _svUpdateScoreBadge();
                _svEmitNoteResult(true);
                return n.noteKey;
            }
        }
        _svMisses++;
        _svStreak = 0;
        _svUpdateScoreBadge();
        _svEmitNoteResult(false);
        return null;
    }

    // Bare bus events (no payload read by either consumer) that bridge our
    // judgment into the core stats pipeline — stats-recorder.js /
    // live-performance-hud.js listen for exactly these two names, matching
    // what the (optional) feedBack-plugin-notedetect emits. Without this,
    // our note-detection domain reporting (PR4a) is invisible to core's
    // HUD/dashboard/song_stats — the two systems are otherwise unconnected.
    function _svEmitNoteResult(hit) {
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            window.feedBack.emit(hit ? 'note:hit' : 'note:miss', {});
        }
    }

    // Accuracy as a percentage, matching core's lib/song_score.py:
    // accuracy = hits / max(1, hits + misses).
    function _svAccuracyPct(hits, misses) {
        const total = hits + misses;
        return total > 0 ? (hits / total) * 100 : 0;
    }

    // Get (lazily creating) our per-hand line as the last child of core's
    // live HUD box. Returns null when the HUD doesn't exist (v2 / not yet in
    // the DOM). Reuses a core HUD line class so it inherits the HUD's theming.
    // Re-appends if a relayout ever detached it. Single shared node id — one
    // global HUD means the focused instance's figures win in splitscreen.
    function _svHandAccEl() {
        const hud = document.getElementById('v3-live-performance-hud');
        if (!hud) return null;
        let el = document.getElementById('staffview-hand-acc');
        if (!el) {
            el = document.createElement('div');
            el.id = 'staffview-hand-acc';
            el.className = 'v3-live-performance-streak';
        }
        if (el.parentElement !== hud) hud.appendChild(el);
        return el;
    }

    // Refresh our per-hand (RH/LH) accuracy line inside core's live HUD.
    // We inject a single line as the last child of #v3-live-performance-hud
    // (see _svHandAccEl) — core's own line already shows the aggregate, so
    // ours surfaces only the per-hand split it can't. Shown only on two-staff
    // scores once at least one note is judged. Per-hand denominators count
    // that hand's own swept (skipped) notes; a wrong key-press can't be
    // attributed to a hand, so it lands only in the combined figure. v3-only:
    // no HUD element ⇒ no-op (v2 has no live scoreboard).
    function _svUpdateScoreBadge() {
        const el = _svHandAccEl();
        if (!el) return;
        const twoStaff = _svJudgeNotesRH && _svJudgeNotesRH.length
                      && _svJudgeNotesLH && _svJudgeNotesLH.length;
        if (!twoStaff || (_svHits + _svMisses) <= 0) {
            el.style.display = 'none';
            return;
        }
        const rh = _svAccuracyPct(_svHitsRH, _svMissesRH);
        const lh = _svAccuracyPct(_svHitsLH, _svMissesLH);
        el.textContent = `RH ${rh.toFixed(0)}%  ·  LH ${lh.toFixed(0)}%`;
        el.style.display = '';
    }

    // ── Miss-dot overlay: sizing, drawing, sweep ────────────────────────
    // The overlay canvas is pinned to the alphaTab render mount and sized to
    // the full scroll extent so dots stay aligned with noteheads as the score
    // is scrolled. alphaTab renders its SVGs position:absolute, so on the
    // first renderFinished scrollHeight can be 0 — fall back to boundsLookup
    // staff-system extents in that case.
    function _svResizeMissCanvas() {
        if (!_svMissCanvas || !_svAtMount) return;
        _svMissCanvas.style.left = _svAtMount.offsetLeft + 'px';
        _svMissCanvas.style.top  = _svAtMount.offsetTop  + 'px';
        const w = _svAtMount.scrollWidth  || _svAtMount.clientWidth;
        let h   = _svAtMount.scrollHeight || _svAtMount.clientHeight;
        if (!h) {
            const bl = _svApi && _svApi.boundsLookup;
            if (bl && bl.staffSystems) {
                for (const sys of (bl.staffSystems || [])) {
                    const vb = sys && sys.visualBounds;
                    if (vb) h = Math.max(h, vb.y + vb.h);
                }
            }
        }
        _svMissCanvas.width  = w;
        _svMissCanvas.height = h;
    }

    // Draw a single red dot immediately left of the missed note's head, using
    // the beat/noteIdx references stored on the judge entry so we can query
    // boundsLookup.findBeat(...).notes[ni].noteHeadBounds without re-walking
    // the score model.
    function _svDrawMissDot(ctx, entry) {
        const bl = _svApi && _svApi.boundsLookup;
        if (!bl || typeof bl.findBeat !== 'function') return;
        const beatBounds = bl.findBeat(entry.beat);
        if (!beatBounds || !beatBounds.notes) return;
        const nb = beatBounds.notes[entry.noteIdx];
        if (!nb || !nb.noteHeadBounds) return;
        const nhb = nb.noteHeadBounds;
        const r = 2, gap = 2;
        ctx.beginPath();
        ctx.arc(Math.round(nhb.x - gap - r), Math.round(nhb.y + nhb.h / 2), r, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
    }

    // MIDI note → diatonic step number (C-major staff position), used to place
    // a wrong-note X at its true pitch on the staff.
    function _svMidiToDiatonic(midi) {
        const chromToD = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
        return (Math.floor(midi / 12) - 1) * 7 + chromToD[midi % 12];
    }

    // Study mode: draw an orange X at the pitch the player actually hit (wrong),
    // offset from the nearest gate notehead by the diatonic distance, with
    // clef-aware ledger lines when the pitch sits off the staff.
    function _svDrawStudyWrongX(ctx, wrongMidi, gateEntries) {
        if (!gateEntries || !gateEntries.length) return;
        const bl = _svApi && _svApi.boundsLookup;
        if (!bl || typeof bl.findBeat !== 'function') return;
        const ref = gateEntries.reduce((best, n) =>
            Math.abs(n.midi - wrongMidi) < Math.abs(best.midi - wrongMidi) ? n : best
        );
        const beatBounds = bl.findBeat(ref.beat);
        if (!beatBounds || !beatBounds.notes) return;
        const nb = beatBounds.notes[ref.noteIdx];
        if (!nb || !nb.noteHeadBounds) return;
        const nhb = nb.noteHeadBounds;
        const refD  = _svMidiToDiatonic(ref.midi);
        const wrongD = _svMidiToDiatonic(wrongMidi);
        const dOff  = wrongD - refD;
        const ls    = nhb.h;            // line spacing ≈ notehead height
        const refCY = nhb.y + ls / 2;
        const cx    = Math.round(nhb.x + nhb.w / 2);
        const cy    = Math.round(refCY - dOff * ls / 2);

        // Ledger lines: treble bottom = E4 (diatonic 30), bass bottom = G2 (18)
        const bottomD = ref.hand === 0 ? 30 : 18;
        const topD    = bottomD + 8;
        const halfW   = Math.round(nhb.w * 0.75);
        ctx.strokeStyle = '#f97316';
        ctx.lineWidth   = 1;
        for (let d = bottomD - 2; d >= wrongD; d -= 2) {
            const ly = Math.round(refCY - (d - refD) * ls / 2);
            ctx.beginPath(); ctx.moveTo(cx - halfW, ly); ctx.lineTo(cx + halfW, ly); ctx.stroke();
        }
        for (let d = topD + 2; d <= wrongD; d += 2) {
            const ly = Math.round(refCY - (d - refD) * ls / 2);
            ctx.beginPath(); ctx.moveTo(cx - halfW, ly); ctx.lineTo(cx + halfW, ly); ctx.stroke();
        }

        const arm = 3;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy - arm); ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx + arm, cy - arm); ctx.lineTo(cx - arm, cy + arm);
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Full repaint of every recorded miss dot — cheap, and the only reliable
    // way to keep dots aligned after an alphaTab relayout (bounds change).
    // Also repaints study-mode wrong-note X markers when active.
    function _svRedrawAllMissDots() {
        if (!_svMissCanvas) return;
        const ctx = _svMissCanvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, _svMissCanvas.width, _svMissCanvas.height);
        for (const key of _svMissNotes) {
            const entry = _svMissEntryByKey.get(key);
            if (entry) _svDrawMissDot(ctx, entry);
        }
        if (_svStudyMode) {
            for (const [gateIdx, midiSet] of _svStudyWrongAttempts) {
                const gate = _svStudyGates[gateIdx];
                if (!gate) continue;
                for (const wrongMidi of midiSet) {
                    _svDrawStudyWrongX(ctx, wrongMidi, gate.entries);
                }
            }
        }
    }

    // Backward seek (or replay from earlier): notes at/after the new position
    // are un-judged so they can be re-scored on the next pass. Miss dots for
    // those notes are cleared ("overwrite on replay"); dots for sections not
    // yet replayed stay visible until the player reaches them again.
    function _svHandleSeek(newTime) {
        if (!_svJudgeNotesAll) return;
        let changed = false;
        for (const key of _svMissNotes) {
            const entry = _svMissEntryByKey.get(key);
            if (entry && entry.t >= newTime) {
                _svMissNotes.delete(key);
                changed = true;
            }
        }
        for (const e of _svJudgeNotesAll) {
            if (e.t >= newTime) _svHitNoteKeys.delete(e.noteKey);
        }
        _svMissSweepIdx = 0;
        while (_svMissSweepIdx < _svJudgeNotesAll.length &&
               _svJudgeNotesAll[_svMissSweepIdx].t < newTime - HIT_TOLERANCE_S - 0.05) {
            _svMissSweepIdx++;
        }
        if (changed) _svRedrawAllMissDots();
    }

    // Monotonic sweep over the judge list as playback advances: any chart note
    // whose hit window has fully closed without a matching MIDI hit is recorded
    // as a swept miss — a red dot, and a miss for both the per-hand and the
    // combined counters (so skipping notes can't inflate accuracy). Detects a
    // backward jump (>0.5s) via _svLastSweepTime and rewinds state first.
    function _svSweepMisses(currentTime) {
        if (!_svMissCanvas || !_svJudgeNotesAll || !_svJudgeNotesAll.length) return;
        if (currentTime === null || currentTime < 0) return;
        // Any jump >0.5s in EITHER direction is a seek, not natural playback
        // (which advances well under 0.5s per frame). Re-sync the sweep index
        // to the new position without marking the jumped-over region: a forward
        // seek (click-to-seek, section jump, platform seek-ahead) must not paint
        // the skipped span red — only notes actually passed during playback are
        // misses. _svHandleSeek's index walk and cleanup are direction-agnostic.
        if (_svLastSweepTime >= 0 && Math.abs(currentTime - _svLastSweepTime) > 0.5) {
            _svHandleSeek(currentTime);
        }
        _svLastSweepTime = currentTime;
        const cutoff = currentTime - HIT_TOLERANCE_S - 0.05;
        const ctx = _svMissCanvas.getContext('2d');
        while (_svMissSweepIdx < _svJudgeNotesAll.length) {
            const n = _svJudgeNotesAll[_svMissSweepIdx];
            if (n.t > cutoff) break;
            _svMissSweepIdx++;
            // In an isolated-hand session only the active hand is judged.
            if (_svActiveHands !== 'both'
                    && n.hand !== (_svActiveHands === 'rh' ? 0 : 1)) continue;
            if (!_svHitNoteKeys.has(n.noteKey) && !_svMissNotes.has(n.noteKey)) {
                _svMissNotes.add(n.noteKey);
                if (ctx) _svDrawMissDot(ctx, n);
                if (n.hand === 0) _svMissesRH++; else _svMissesLH++;
                _svMisses++;
                _svStreak = 0;
                _svUpdateScoreBadge();
                _svEmitNoteResult(false);
            }
        }
    }

    // ── LH/RH hand isolation ────────────────────────────────────────────
    // Restart the live judging session: counters, claimed sets, sweep cursor
    // and the miss-dot canvas back to a clean slate, then re-sync the sweep
    // cursor to the current playback position so notes already in the past are
    // not retroactively marked missed. Shared by chart (re)load and hand
    // switches — both change what counts, so both restart scoring.
    function _svResetJudgeState() {
        _svHitNoteKeys.clear();
        _svMissNotes.clear();
        _svMissSweepIdx  = 0;
        _svLastSweepTime = -1;
        _svHits = 0; _svMisses = 0; _svStreak = 0; _svBestStreak = 0;
        _svHitsRH = 0; _svMissesRH = 0; _svHitsLH = 0; _svMissesLH = 0;
        const now = _svGetCurrentTime();
        if (_svJudgeNotesAll && now && now > 0) {
            while (_svMissSweepIdx < _svJudgeNotesAll.length
                   && _svJudgeNotesAll[_svMissSweepIdx].t < now) {
                _svMissSweepIdx++;
            }
        }
        _svRedrawAllMissDots();   // miss set is empty → clears the canvas
        _svUpdateScoreBadge();
    }

    function _svUpdateHandButtons() {
        if (_svRhBtn) {
            _svRhBtn.style.opacity   = (_svActiveHands === 'rh') ? '1' : '0.7';
            _svRhBtn.style.boxShadow = (_svActiveHands === 'rh') ? '0 0 0 1px #22c55e' : '';
        }
        if (_svLhBtn) {
            _svLhBtn.style.opacity   = (_svActiveHands === 'lh') ? '1' : '0.7';
            _svLhBtn.style.boxShadow = (_svActiveHands === 'lh') ? '0 0 0 1px #22c55e' : '';
        }
    }

    // Switch which hand is judged ('both' | 'rh' | 'lh'). Isolating a hand
    // changes what scores, so it restarts the session and re-colours the score.
    function _svSetActiveHands(hand) {
        if (hand === _svActiveHands) return;
        _svActiveHands = hand;
        _svResetJudgeState();
        // Study gates are hand-scoped — rebuild and re-home to the current
        // playback position when isolation changes mid-session.
        if (_svStudyMode) {
            _svStudyBuildGates();
            _svStudyChordHit.clear();
            const tNow = _svGetCurrentTime() || 0;
            _svStudyGateIdx = 0;
            while (_svStudyGateIdx < _svStudyGates.length - 1 &&
                   _svStudyGates[_svStudyGateIdx].gateTime < tNow) {
                _svStudyGateIdx++;
            }
            _svStudyGateTime = _svStudyGateIdx < _svStudyGates.length
                ? _svStudyGates[_svStudyGateIdx].gateTime : null;
            _svStudySnapCursor();
        }
        _svUpdateHandButtons();
        _svApplyHandColors();
    }

    // Dim the inactive staff using alphaTab's native per-element colouring,
    // then re-render. Colours live on the model objects, so they survive
    // layout reflows and only need re-applying on an explicit switch (NOT from
    // renderFinished, which would loop). Switching back to 'both' resets the
    // styles. Grand staff only (needs ≥ 2 staves).
    function _svApplyHandColors() {
        if (!_svApi || !_svApiReady || !window.alphaTab) return;
        const score = _svApi.score;
        if (!score || !score.tracks || !score.tracks.length) return;
        const track = score.tracks[0];
        if (!track.staves || track.staves.length < 2) return;

        const m      = window.alphaTab.model;
        const grey   = m.Color.fromJson('#c0c0c0');
        const dimIdx = _svActiveHands === 'rh' ? 1 : 0;

        for (let si = 0; si < track.staves.length; si++) {
            const dim = _svActiveHands !== 'both' && si === dimIdx;
            for (const bar of track.staves[si].bars) {
                for (const voice of bar.voices) {
                    for (const beat of voice.beats) {
                        if (dim) {
                            if (!beat.style) beat.style = new m.BeatStyle();
                            for (const k of Object.values(m.BeatSubElement))
                                beat.style.colors.set(k, grey);
                        } else {
                            beat.style = new m.BeatStyle();
                        }
                        for (const note of beat.notes) {
                            if (dim) {
                                if (!note.style) note.style = new m.NoteStyle();
                                for (const k of Object.values(m.NoteSubElement))
                                    note.style.colors.set(k, grey);
                            } else {
                                note.style = new m.NoteStyle();
                            }
                        }
                    }
                }
            }
        }
        try { _svApi.render(); } catch (_) {}
    }

    // ── Study mode functions ────────────────────────────────────────────
    // Build the gate list from the judge notes: one gate per beat-position
    // (per hand when a hand is isolated). Both-hands collapses treble + bass
    // at the same beat into a single gate so a two-hand attack satisfies it in
    // any order. Gates are sorted by time.
    function _svStudyBuildGates() {
        _svStudyGates   = [];
        _svStudyGateIdx = 0;
        _svStudyWrongAttempts.clear();
        if (!_svJudgeNotesAll) return;
        const activeHand = _svActiveHands === 'rh' ? 0 : _svActiveHands === 'lh' ? 1 : null;
        const map = new Map();
        for (const n of _svJudgeNotesAll) {
            if (activeHand !== null && n.hand !== activeHand) continue;
            const key = activeHand !== null
                ? n.beat.absoluteDisplayStart + ':' + n.hand
                : n.beat.absoluteDisplayStart;
            if (!map.has(key)) map.set(key, { gateTime: n.t, entries: [] });
            else if (n.t < map.get(key).gateTime) map.get(key).gateTime = n.t;
            map.get(key).entries.push(n);
        }
        _svStudyGates = Array.from(map.values()).sort((a, b) => a.gateTime - b.gateTime);
    }

    function _svStudyGetBeatEntries() {
        if (_svStudyGateIdx >= _svStudyGates.length) return [];
        return _svStudyGates[_svStudyGateIdx].entries;
    }

    // Snap the cursor to the current gate's beat (study cursor follows gate
    // position, not audio time).
    function _svStudySnapCursor() {
        if (_svStudyGateIdx >= _svStudyGates.length) {
            if (_svMarker) _svMarker.style.display = 'none';
            return;
        }
        const entries = _svStudyGates[_svStudyGateIdx].entries;
        if (!entries || !entries.length) return;
        _svLastBeat = entries[0].beat;
        _svUpdateMarker();
    }

    // Current gate satisfied → clear its wrong-note marks, advance, resume OGG.
    function _svStudyAdvance() {
        _svStudyWrongAttempts.delete(_svStudyGateIdx);
        _svRedrawAllMissDots();
        _svStudyChordHit.clear();
        _svStudyGateIdx++;
        _svStudyGateTime = _svStudyGateIdx < _svStudyGates.length
            ? _svStudyGates[_svStudyGateIdx].gateTime : null;
        _svStudySnapCursor();
        _svPrerollResuming = true;   // gate advance — no preroll on resume
        try {
            const audio = document.getElementById('audio');
            if (audio && audio.paused) audio.play();
        } catch (_) {}
    }

    // MIDI note-on while study mode is active: judge it against the current
    // gate. Correct notes accumulate until the chord is complete (→ advance);
    // wrong notes draw an X and count as a miss. Feeds the same core stats /
    // note-detection channels as free-play judging.
    function _svStudyHandleNoteOn(midi) {
        if (_svStudyCountingDown) return;
        if (_svStudyGateIdx >= _svStudyGates.length) return;
        const entries = _svStudyGetBeatEntries();
        const matched = entries.find(n => n.midi === midi && !_svStudyChordHit.has(n.noteKey));
        if (matched) {
            _svStudyChordHit.add(matched.noteKey);
            _svHitNoteKeys.add(matched.noteKey);
            _svHits++;
            if (matched.hand === 0) _svHitsRH++; else _svHitsLH++;
            _svStreak++;
            if (_svStreak > _svBestStreak) _svBestStreak = _svStreak;
            if (_svMissNotes.has(matched.noteKey)) {
                _svMissNotes.delete(matched.noteKey);
                _svRedrawAllMissDots();
            }
            _svUpdateScoreBadge();
            _svNdReport(true, midi, _svNdBindingId);
            _svEmitNoteResult(true);
            if (entries.every(n => _svStudyChordHit.has(n.noteKey))) {
                _svStudyAdvance();
            }
        } else {
            _svMisses++;
            _svStreak = 0;
            _svUpdateScoreBadge();
            _svNdReport(false, midi, _svNdBindingId);
            _svEmitNoteResult(false);
            if (!_svStudyWrongAttempts.has(_svStudyGateIdx))
                _svStudyWrongAttempts.set(_svStudyGateIdx, new Set());
            // Sequential wrong attempts replace each other; simultaneous wrong
            // notes (still held) accumulate — evict any no longer held first.
            const wrongSet = _svStudyWrongAttempts.get(_svStudyGateIdx);
            for (const m of wrongSet) { if (!_svHeldNotes.has(m)) wrongSet.delete(m); }
            wrongSet.add(midi);
            _svRedrawAllMissDots();
        }
    }

    function _svUpdateStudyBtn() {
        if (!_svStudyBtnEl) return;
        _svStudyBtnEl.textContent = _svStudyMode ? 'Study mode ✓' : 'Study mode';
        _svStudyBtnEl.style.opacity   = _svStudyMode ? '1' : '0.7';
        _svStudyBtnEl.style.boxShadow = _svStudyMode ? '0 0 0 1px #22c55e' : '';
    }

    // A short metronome click for the preroll countdown (own AudioContext,
    // closed on teardown).
    function _svStudyBeep(accent) {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            if (!_svStudyAudioCtx || _svStudyAudioCtx.state === 'closed') {
                _svStudyAudioCtx = new AudioCtx();
            }
            const ctx = _svStudyAudioCtx;
            if (ctx.state === 'suspended') ctx.resume();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = accent ? 1400 : 900;
            gain.gain.setValueAtTime(0.25, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.06);
        } catch (_) {}
    }

    // One-bar count-in before playback resumes (study + preroll enabled).
    function _svStudyStartCountdown(onDone) {
        const score       = _svApi && _svApi.score;
        const bpm         = (score && score.tempo) ? score.tempo : 120;
        const mb          = score && score.masterBars && score.masterBars.length
                            ? score.masterBars[0] : null;
        const beatsPerBar = mb ? (mb.timeSignatureNumerator || 4) : 4;
        const beatMs      = (60 / bpm) * 1000;
        _svStudyCountingDown = true;
        let beatIdx = 0;
        _svStudyBeep(true);   // beat 1 — accent
        beatIdx++;
        _svStudyCountdownId = setInterval(() => {
            if (beatIdx < beatsPerBar) {
                _svStudyBeep(false);
                beatIdx++;
            } else {
                clearInterval(_svStudyCountdownId);
                _svStudyCountdownId  = null;
                _svStudyCountingDown = false;
                onDone();
            }
        }, beatMs);
    }

    // A platform-initiated seek (scrub bar) while study is active: re-home the
    // gate to the seeked position and clear per-gate progress.
    function _svStudyAttachSeekHandler() {
        const audio = document.getElementById('audio');
        if (!audio || _svStudySeekHandler) return;
        _svStudySeekHandler = function () {
            if (!_svStudyMode) return;
            const t = audio.currentTime || 0;
            _svStudyGateIdx = 0;
            while (_svStudyGateIdx < _svStudyGates.length - 1 &&
                   _svStudyGates[_svStudyGateIdx].gateTime < t) {
                _svStudyGateIdx++;
            }
            _svStudyGateTime = _svStudyGateIdx < _svStudyGates.length
                ? _svStudyGates[_svStudyGateIdx].gateTime : null;
            _svStudyChordHit.clear();
            _svStudyWrongAttempts.clear();
            _svRedrawAllMissDots();
            _svStudySnapCursor();
        };
        audio.addEventListener('seeked', _svStudySeekHandler);
    }

    function _svStudyDetachSeekHandler() {
        if (!_svStudySeekHandler) return;
        try {
            const audio = document.getElementById('audio');
            if (audio) audio.removeEventListener('seeked', _svStudySeekHandler);
        } catch (_) {}
        _svStudySeekHandler = null;
    }

    function _svStudyActivate() {
        if (!_svJudgeNotesAll || !_svJudgeNotesAll.length) return;
        _svStudyMode = true;
        _svStudyChordHit.clear();
        // Build the gate list and home to the current position — do NOT touch OGG.
        _svStudyBuildGates();
        const t = _svGetCurrentTime() || 0;
        _svStudyGateIdx = 0;
        while (_svStudyGateIdx < _svStudyGates.length - 1 &&
               _svStudyGates[_svStudyGateIdx].gateTime < t) {
            _svStudyGateIdx++;
        }
        _svStudyGateTime = _svStudyGateIdx < _svStudyGates.length
            ? _svStudyGates[_svStudyGateIdx].gateTime : null;
        _svStudyAttachSeekHandler();
        _svStudySnapCursor();
        _svUpdateStudyBtn();
    }

    function _svStudyDeactivate() {
        if (_svStudyCountdownId !== null) {
            clearInterval(_svStudyCountdownId);
            _svStudyCountdownId  = null;
            _svStudyCountingDown = false;
        }
        _svStudyDetachSeekHandler();
        _svStudyMode     = false;
        _svStudyGateTime = null;
        _svStudyChordHit.clear();
        _svStudyWrongAttempts.clear();
        _svRedrawAllMissDots();
        _svUpdateStudyBtn();
    }

    // ── MIDI event handlers (called by the module-level _svMidiOnMessage,
    // routed to whichever instance is currently focused) ────────────────

    function _handleNoteOn(midi, velocity) {
        if (midi < 0 || midi > 127) return;
        _svHeldNotes.set(midi, velocity);
        _svMonitorNoteOn(midi);
        // Study mode judges against the current gate (its own scoring/report
        // path); free-play judges against playback time.
        if (_svStudyMode) {
            _svStudyHandleNoteOn(midi);
            return;
        }
        const t = _svGetCurrentTime();
        if (t !== null) {
            const hitKey = _svJudgeHit(midi, t);
            _svNdReport(hitKey !== null, midi, _svNdBindingId);
        }
    }

    function _handleNoteOff(midi) {
        if (midi < 0 || midi > 127) return;
        if (_svSustainOn) { _svSustainedNotes.add(midi); return; }
        _svHeldNotes.delete(midi);
        _svMonitorNoteOff(midi);
    }

    function _handleSustain(down) {
        if (down) {
            _svSustainOn = true;
        } else {
            _svSustainOn = false;
            for (const midi of _svSustainedNotes) {
                _svHeldNotes.delete(midi);
                _svMonitorNoteOff(midi);
            }
            _svSustainedNotes.clear();
        }
    }

    // ── Note-detection binding (per chart load) ─────────────────────
    // Closes any previous binding, ensures the (idempotent) provider
    // registration, then opens a binding scoped to this chart's judged
    // MIDI range. All guarded — degrades silently when the note-detection
    // host is absent. `seq` is this instance's chart-load sequence: a
    // rapid song switch can land a stale open-binding response after the
    // next chart is already active, which would misattribute hit/miss
    // events and leak the live binding — so the write-back is gated on
    // the same supersession check the notation load itself uses, and a
    // superseded binding is closed instead of stored.

    async function _svNdOpenBindingForChart(seq) {
        if (_svNdBindingId) {
            _svCapCommand('note-detection', 'close-binding', { bindingId: _svNdBindingId },
                'Song changed — close the previous notation binding');
            _svNdBindingId = null;
        }
        // Registration must not depend on this chart having judge notes —
        // an empty/failed range must still leave staffview registered as a
        // provider (matches keys_highway_3d: register-provider is
        // unconditional). Only the per-chart BINDING is skipped without a
        // range.
        await _svNdEnsureProvider();
        const range = _svJudgeMidiRange();
        if (!range) return;
        const p = await _svCapCommand('note-detection', 'open-binding', {
            providerId: ND_PROVIDER_ID,
            context: { arrangement: 'notation', midiLow: range.activeLow, midiHigh: range.activeHigh },
        }, 'Open a notation verify binding for the loaded chart');
        const bindingId = p && p.bindingId;
        if (!bindingId) return;
        if (seq !== _svNdLoadSeq) {
            _svCapCommand('note-detection', 'close-binding', { bindingId },
                'Superseded by a newer chart load');
            return;
        }
        _svNdBindingId = bindingId;
    }

    // ── Teardown ───────────────────────────────────────────────────

    function _svTeardown(restoreCanvas) {
        if (_svMarkerRefreshTimer) { clearInterval(_svMarkerRefreshTimer); _svMarkerRefreshTimer = null; }
        // Notation is going away — restore core's HUD to the top bar (no-op if
        // this instance wasn't the one showing notation).
        _svSetNotationShowing(instance, false);
        // Tear down study mode: stop any countdown, detach the seek listener,
        // reset gate state, and close the metronome AudioContext (hardware).
        if (_svStudyCountdownId !== null) {
            clearInterval(_svStudyCountdownId);
            _svStudyCountdownId  = null;
        }
        _svStudyDetachSeekHandler();
        _svStudyMode         = false;
        _svStudyCountingDown = false;
        _svStudyGates        = [];
        _svStudyGateIdx      = 0;
        _svStudyGateTime     = null;
        _svStudyChordHit.clear();
        _svStudyWrongAttempts.clear();
        _svPrerollResuming   = false;
        _svWasAudioPaused    = null;
        if (_svStudyAudioCtx) {
            try { _svStudyAudioCtx.close(); } catch (_) {}
            _svStudyAudioCtx = null;
        }
        _svUpdateStudyBtn();
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

        // Reset miss-dot sweep state (the canvas itself goes with the
        // container in _svRemoveContainer below).
        _svMissNotes.clear();
        _svMissEntryByKey.clear();
        _svMissSweepIdx  = 0;
        _svLastSweepTime = -1;

        _svCloseWs();

        if (_svApi) {
            try { _svApi.destroy(); } catch (_) {}
            _svApi = null;
        }

        _svRemoveContainer();
        _svRemoveErrorBanner();
        _svSuppressNoteDetect(false);

        if (restoreCanvas && _svHighwayCanvas) {
            _svHighwayCanvas.style.visibility = _svPrevVisibility;
            _svSetHighwayVisible(null);
            _svHighwayCanvas  = null;
            _svPrevVisibility = '';
        }
    }

    // ── setRenderer contract ───────────────────────────────────────
    // `instance` is declared as a const (not returned anonymously) so
    // _svUpdateFocusState can close over it by reference — the ref is only
    // dereferenced after init() has run, by which point this assignment
    // has already happened.

    const _onFocusChange = () => _svUpdateFocusState();

    const instance = {
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

            // Wire focus routing once per instance. In splitscreen,
            // focus-change events route MIDI to the focused panel; the
            // main player has only one panel so focus is always true.
            _svInstanceDestroyed = false;
            _svInstances.add(instance);
            if (!_svFocusRegistered) {
                _svFocusRegistered = true;
                if (_ssActiveFull()) {
                    const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
                    if (typeof ss.onFocusChange === 'function') ss.onFocusChange(_onFocusChange);
                }
            }
            if (_ssActiveFull()) {
                _svUpdateFocusState();
            } else {
                _svActiveInst = instance;
                _svIsFocused  = true;
            }
            _svMidiResume();
            _svMidiInit();   // lazy MIDI access — no-op if already initialised

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
            _svSweepMisses(bundle.currentTime);

            // Study mode: preroll count-in on manual play, and gate-pause when
            // the OGG reaches the next required note.
            try {
                const audio = document.getElementById('audio');
                if (audio) {
                    const nowPaused = audio.paused;
                    if (_svWasAudioPaused === null) {
                        _svWasAudioPaused = nowPaused;   // first observation only
                    } else if (!nowPaused && _svWasAudioPaused) {
                        // paused → playing: if the user pressed play, do a preroll.
                        if (_svStudyMode && _svPrerollEnabled
                                && !_svPrerollResuming && !_svStudyCountingDown) {
                            audio.pause();
                            _svStudyStartCountdown(() => {
                                _svPrerollResuming = true;
                                try { audio.play(); } catch (_) {}
                            });
                        }
                        _svPrerollResuming = false;
                    }
                    if (_svStudyMode && !_svStudyCountingDown && !audio.paused
                            && _svStudyGateTime !== null
                            && audio.currentTime >= _svStudyGateTime) {
                        audio.pause();
                    }
                    _svWasAudioPaused = audio.paused;
                }
            } catch (_) {}
        },

        resize(/* w, h */) {
            if (!_isReady) return;
            _svSizeContainer();
            if (_svApi) {
                try { _svApi.render(); } catch (_) {}
            }
        },

        destroy() {
            _svInstanceDestroyed = true;
            _svInstances.delete(instance);
            if (_svActiveInst === instance) _svActiveInst = null;
            if (_svFocusRegistered && _ssActiveFull()) {
                const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
                if (typeof ss.offFocusChange === 'function') ss.offFocusChange(_onFocusChange);
                _svFocusRegistered = false;
            }
            if (_svNdBindingId) {
                _svCapCommand('note-detection', 'close-binding', { bindingId: _svNdBindingId },
                    'Instance torn down — close the notation binding');
                _svNdBindingId = null;
            }
            if (_svInstances.size === 0) {
                _svMidiReleaseSession();
                _svNdUnregisterProvider();
            }
            _isReady = false;
            _svInitToken++;
            window.removeEventListener('resize', _onWinResize);
            _svTeardown(/* restoreCanvas */ true);
        },

        // ── MIDI handler entry-points (called by the module-level
        // _svMidiOnMessage, routed to whichever instance is focused) ──
        _releaseAllHeld: _svReleaseAllHeld,
        _handleNoteOn,
        _handleNoteOff,
        _handleSustain,
    };

    return instance;
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
