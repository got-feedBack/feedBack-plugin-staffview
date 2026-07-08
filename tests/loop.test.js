'use strict';
/*
 * Tests for the two pure OGG-loop helpers backing drag-select and the
 * platform loop-sync listener:
 *
 *   _svOrderBeats(beatA, beatB)       — normalizes a drag's start/end beats
 *                                        regardless of drag direction.
 *   _svParseLoopEventDetail(detail)   — normalizes the two shapes the
 *                                        platform's loop notifications
 *                                        arrive in ('loop:restart' vs
 *                                        'playback:loop-set') into a single
 *                                        { startTime, endTime } shape.
 *
 * No DOM/window dependency — extract the real source from screen.js and
 * compile it directly. Same extraction approach as zoom.test.js /
 * pitch_label.test.js.
 *
 * Run: node --test tests/loop.test.js
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

const parseDetailSrc = grab(/function _svParseLoopEventDetail\(detail\) \{[\s\S]*?\n\}/, '_svParseLoopEventDetail');
const orderBeatsSrc   = grab(/function _svOrderBeats\(beatA, beatB\) \{[\s\S]*?\n\}/, '_svOrderBeats');
const horizDragSrc    = grab(/function _svIsHorizontalDrag\(dx, dy\) \{[\s\S]*?\n\}/, '_svIsHorizontalDrag');
const validSpanSrc    = grab(/function _svIsValidLoopSpan\(timeA, timeB\) \{[\s\S]*?\n\}/, '_svIsValidLoopSpan');

function load() {
    return new Function(
        '"use strict";' + parseDetailSrc + '\n' + orderBeatsSrc + '\n'
        + horizDragSrc + '\n' + validSpanSrc
        + '\nreturn { _svParseLoopEventDetail, _svOrderBeats, _svIsHorizontalDrag, _svIsValidLoopSpan };'
    )();
}
const { _svParseLoopEventDetail, _svOrderBeats, _svIsHorizontalDrag, _svIsValidLoopSpan } = load();

// ── _svOrderBeats ─────────────────────────────────────────────────────────

function beat(tick, key) {
    return key === 'display' ? { absoluteDisplayStart: tick } : { absolutePlaybackStart: tick };
}

test('_svOrderBeats returns [A, B] unchanged when A is already earlier', () => {
    const a = beat(100, 'display'), b = beat(200, 'display');
    assert.deepEqual(_svOrderBeats(a, b), [a, b]);
});

test('_svOrderBeats swaps to [B, A] when A is later than B', () => {
    const a = beat(500, 'display'), b = beat(100, 'display');
    assert.deepEqual(_svOrderBeats(a, b), [b, a]);
});

test('_svOrderBeats treats equal ticks as already ordered (stable, no swap)', () => {
    const a = beat(300, 'display'), b = beat(300, 'display');
    assert.deepEqual(_svOrderBeats(a, b), [a, b]);
});

test('_svOrderBeats falls back to absolutePlaybackStart when absoluteDisplayStart is absent', () => {
    const a = beat(400, 'playback'), b = beat(100, 'playback');
    assert.deepEqual(_svOrderBeats(a, b), [b, a]);
});

test('_svOrderBeats treats a beat with neither field as tick 0', () => {
    const a = {}; // no absoluteDisplayStart, no absolutePlaybackStart
    const b = beat(50, 'display');
    // a (tick 0) is earlier than b (tick 50) → order unchanged.
    assert.deepEqual(_svOrderBeats(a, b), [a, b]);
    // Reversed args: b (50) is later than a (0) → swap.
    assert.deepEqual(_svOrderBeats(b, a), [a, b]);
});

// ── _svParseLoopEventDetail ───────────────────────────────────────────────

test('parses a playback:loop-set style detail (payload.loop.startTime/endTime)', () => {
    const detail = { capability: 'playback', event: 'loop-set', payload: { loop: { startTime: 1.5, endTime: 4.25, enabled: true } } };
    assert.deepEqual(_svParseLoopEventDetail(detail), { startTime: 1.5, endTime: 4.25 });
});

test('parses a loop:restart style detail (loopA/loopB directly on detail)', () => {
    const detail = { loopA: 2, loopB: 6, time: 2 };
    assert.deepEqual(_svParseLoopEventDetail(detail), { startTime: 2, endTime: 6 });
});

test('prefers the payload.loop shape over loopA/loopB when both happen to be present', () => {
    const detail = { loopA: 99, loopB: 100, payload: { loop: { startTime: 1, endTime: 2 } } };
    assert.deepEqual(_svParseLoopEventDetail(detail), { startTime: 1, endTime: 2 });
});

test('returns null when payload.loop is missing startTime/endTime', () => {
    const detail = { payload: { loop: { enabled: false, state: 'inactive' } } }; // loop-cleared shape
    assert.equal(_svParseLoopEventDetail(detail), null);
});

test('returns null when neither recognized shape is present', () => {
    assert.equal(_svParseLoopEventDetail({}), null);
    assert.equal(_svParseLoopEventDetail(null), null);
    assert.equal(_svParseLoopEventDetail(undefined), null);
});

test('returns null when loopA/loopB are present but not numbers', () => {
    assert.equal(_svParseLoopEventDetail({ loopA: '2', loopB: 6 }), null);
});

// ── _svIsValidLoopSpan (zero-length loop guard) ───────────────────────────

test('_svIsValidLoopSpan rejects a same-beat / zero-length span', () => {
    // A drag whose start and end resolve to the same time → no loop.
    assert.equal(_svIsValidLoopSpan(3.5, 3.5), false);
});

test('_svIsValidLoopSpan rejects an inverted span (end before start)', () => {
    assert.equal(_svIsValidLoopSpan(4, 2), false);
});

test('_svIsValidLoopSpan rejects unresolved (null) times', () => {
    assert.equal(_svIsValidLoopSpan(null, 2), false);
    assert.equal(_svIsValidLoopSpan(2, null), false);
});

test('_svIsValidLoopSpan accepts a real forward span', () => {
    assert.equal(_svIsValidLoopSpan(1, 2.5), true);
});

// ── _svIsHorizontalDrag (mouse/touch loop-arm dominance gate) ─────────────

test('_svIsHorizontalDrag does NOT arm on a mostly-vertical small move', () => {
    // ~9px move that is mostly vertical (an imprecise click) → not a loop.
    assert.equal(_svIsHorizontalDrag(3, -8), false);
});

test('_svIsHorizontalDrag arms on a horizontally-dominant drag', () => {
    assert.equal(_svIsHorizontalDrag(20, 4), true);
});

test('_svIsHorizontalDrag treats a 45° diagonal as horizontal (matches touch disarm test)', () => {
    assert.equal(_svIsHorizontalDrag(10, -10), true);
});
