'use strict';
/*
 * Tests for the metronome beat-click helper _svMetroTick(currentTime).
 *
 * Backs the pill's METRONOME toggle: a click on every bundle.beats entry
 * during normal (non-study) playback, accented on downbeats (measure >= 0).
 * _svMetroBeatIdx tracks the last index a click fired for, so an ordinary
 * one-beat advance clicks while a seek/jump (or backwards move) just
 * resyncs silently — mirrors _svSyncCursor's binary search.
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
        let _svLatestBeats  = null;
        let _svMetroBeatIdx = -1;
        let _beeps = [];
        let _audio = { paused: false };
        function _svStudyBeep(accent) { _beeps.push(accent); }
        const document = { getElementById: () => _audio };

        ${fnSrc}

        return {
            tick: (t) => _svMetroTick(t),
            setMetro: (v) => { _svMetronomeOn = v; },
            setStudy: (v) => { _svStudyMode = v; },
            setBeats: (b) => { _svLatestBeats = b; },
            setAudio: (a) => { _audio = a; },
            getIdx: () => _svMetroBeatIdx,
            getBeeps: () => _beeps.slice(),
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
