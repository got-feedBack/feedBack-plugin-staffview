'use strict';
/*
 * Tests for the metronome beat-click helper _svMetroTick(currentTime).
 *
 * Backs the pill's METRONOME toggle: a click on every bundle.beats entry
 * during normal (non-study) playback, accented on downbeats (measure >= 0).
 * _svMetroBeatIdx tracks the last index a click fired for, so an ordinary
 * one-beat advance clicks while a seek/jump (or backwards move) just
 * resyncs silently — mirrors _svSyncCursor's binary search. A platform
 * 'seeked' event (even an exact +1 beat) sets _svMetroSeekResync so the
 * next tick resyncs without clicking. Only the focused panel (_svIsFocused)
 * reacts, since #audio is shared across split-screen instances.
 *
 * _svMetroTick closes over several module-level free variables
 * (_svMetronomeOn, _svStudyMode, _svLatestBeats, _svMetroBeatIdx,
 * _svStudyBeep, document) instead of taking them as parameters — same
 * shape as the real _svSyncCursor. Extract the real source text from
 * screen.js and compile it inside a harness that stubs those free
 * variables, so the actual shipped decision logic is under test (not a
 * reimplementation). Same extraction approach as zoom.test.js / study.test.js.
 *
 * Run: node --test tests/metronome.test.js
 */
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function grab(re, label) {
    const m = src.match(re);
    if (!m) throw new Error(`could not extract ${label} from screen.js`);
    return m[0];
}
const fnSrc = grab(/function _svMetroTick\(currentTime\) \{[\s\S]*?\n    \}/, '_svMetroTick');

function load() {
    return new Function(`
        let _svMetronomeOn  = true;
        let _svStudyMode    = false;
        let _svIsFocused    = true;
        let _svLatestBeats  = null;
        let _svMetroBeatIdx = -1;
        let _svMetroSeekResync = false;
        let _svMeasures = [];
        let _beeps = [];
        let _audio = { paused: false };
        function _svStudyBeep(accent) { _beeps.push(accent); }
        function _svMetroAttachSeekHandler() {}   // real attach mechanics not under test here
        const document = { getElementById: () => _audio };

        ${fnSrc}

        return {
            tick: (t) => _svMetroTick(t),
            setMetro: (v) => { _svMetronomeOn = v; },
            setStudy: (v) => { _svStudyMode = v; },
            setFocused: (v) => { _svIsFocused = v; },
            setBeats: (b) => { _svLatestBeats = b; },
            setAudio: (a) => { _audio = a; },
            setSeekResync: (v) => { _svMetroSeekResync = v; },
            setMeasures: (m) => { _svMeasures = m; },
            getIdx: () => _svMetroBeatIdx,
            getBeeps: () => _beeps.slice(),
            getSeekResync: () => _svMetroSeekResync,
        };
    `)();
}

const BEATS = [
    { time: 0.0, measure: 0 },   // downbeat
    { time: 0.5, measure: -1 },
    { time: 1.0, measure: -1 },
    { time: 1.5, measure: 1 },   // downbeat
];

test('_svMetroTick clicks (accented) on the first downbeat and stays silent mid-beat', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), [true], 'downbeat clicks accented');
    assert.equal(h.getIdx(), 0);
    h.tick(0.2);   // still within beat 0
    assert.deepEqual(h.getBeeps(), [true], 'no extra click before the next beat');
});

test('_svMetroTick advances one beat at a time, accenting only downbeats', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);
    h.tick(0.5);
    h.tick(1.0);
    h.tick(1.5);
    assert.deepEqual(h.getBeeps(), [true, false, false, true]);
    assert.equal(h.getIdx(), 3);
});

test('_svMetroTick resyncs silently on a seek/jump instead of clicking', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);
    h.tick(1.5);   // jump forward past beats 1 and 2 — not a one-step advance
    assert.deepEqual(h.getBeeps(), [true], 'jump does not click');
    assert.equal(h.getIdx(), 3, 'index still resyncs to the current beat');
});

test('_svMetroTick resets to -1 on seeking before the first beat', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);
    h.tick(-1);
    assert.equal(h.getIdx(), -1);
    assert.deepEqual(h.getBeeps(), [true], 'no click for the out-of-range seek');
});

test('_svMetroTick is silent when the metronome is off', () => {
    const h = load();
    h.setBeats(BEATS);
    h.setMetro(false);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), []);
});

test('_svMetroTick is silent in study mode (preroll owns its own clicks)', () => {
    const h = load();
    h.setBeats(BEATS);
    h.setStudy(true);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), []);
});

test('_svMetroTick is silent when audio is paused or missing', () => {
    const h = load();
    h.setBeats(BEATS);
    h.setAudio({ paused: true });
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), []);

    h.setAudio(null);
    h.tick(0.5);
    assert.deepEqual(h.getBeeps(), []);
});

test('_svMetroTick is silent with fewer than 2 beats', () => {
    const h = load();
    h.setBeats([{ time: 0, measure: 0 }]);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), []);
});

test('_svMetroTick is silent and does not advance when this panel is unfocused', () => {
    const h = load();
    h.setBeats(BEATS);
    h.setFocused(false);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), [], 'unfocused panel never clicks');
    assert.equal(h.getIdx(), -1, 'unfocused panel does not advance its beat index');
});

test('_svMetroTick resyncs silently on a seeked +1-beat advance instead of clicking', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);          // idx 0, one click
    h.setSeekResync(true);   // simulate the 'seeked' handler firing
    h.tick(0.5);           // exact +1 beat — would normally click
    assert.deepEqual(h.getBeeps(), [true], 'resync suppresses the click');
    assert.equal(h.getIdx(), 1, 'index still resyncs to the current beat');
    assert.equal(h.getSeekResync(), false, 'resync flag is cleared after use');
});

test('_svMetroTick resyncs silently on a seeked backward move', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);
    h.tick(0.5);           // idx 1
    h.setSeekResync(true);
    h.tick(0.0);           // seek backward
    assert.deepEqual(h.getBeeps(), [true, false], 'backward seek adds no further click');
    assert.equal(h.getIdx(), 0, 'index resyncs to the seeked-to beat');
    assert.equal(h.getSeekResync(), false, 'resync flag is cleared after use');
});

test('_svMetroTick does not accent the pickup: first accent lands on bar 1', () => {
    const h = load();
    // 1-beat pickup labeled measure 0 at t=0, first full bar at t=0.5.
    h.setBeats([
        { time: 0.0, measure: 0 },    // pickup start — click, no accent
        { time: 0.5, measure: 1 },    // first full bar downbeat — accent
        { time: 1.0, measure: -1 },
    ]);
    h.setMeasures([{ idx: 0, pickup: true }]);
    h.tick(0.0);
    h.tick(0.5);
    h.tick(1.0);
    assert.deepEqual(h.getBeeps(), [false, true, false]);
});

test('_svMetroTick keeps the first-beat accent when there is no pickup', () => {
    const h = load();
    h.setBeats(BEATS);
    h.setMeasures([{ idx: 0 }]);
    h.tick(0.0);
    assert.deepEqual(h.getBeeps(), [true]);
});

test('_svMetroTick clicks again on the next natural advance after a resync', () => {
    const h = load();
    h.setBeats(BEATS);
    h.tick(0.0);           // idx 0, one click
    h.setSeekResync(true);
    h.tick(0.5);           // resync, no click, idx -> 1
    h.tick(1.0);           // ordinary +1 advance after the resync
    assert.deepEqual(h.getBeeps(), [true, false], 'natural advance beeps again');
    assert.equal(h.getIdx(), 2);
});
