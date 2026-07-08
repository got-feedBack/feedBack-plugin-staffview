'use strict';
/*
 * Tests for the pure accuracy helper _svAccuracyPct(hits, misses).
 *
 * Backs the supplementary score badge and mirrors core's scoring formula
 * (lib/song_score.py): accuracy = hits / max(1, hits + misses), expressed
 * here as a percentage. Zero judged notes yields 0 (not NaN) so the badge
 * never renders a divide-by-zero.
 *
 * Module-scope, no DOM/window dependency — extract the real source text
 * from screen.js and compile it directly. Same extraction approach as
 * zoom.test.js / midi.test.js.
 *
 * Run: node --test tests/score.test.js
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
const accSrc = grab(/function _svAccuracyPct\(hits, misses\) \{[\s\S]*?\n    \}/, '_svAccuracyPct');

function load() {
    return new Function('"use strict";' + accSrc + '\nreturn { _svAccuracyPct };')();
}

const { _svAccuracyPct } = load();

// Real _svHandleSeek source, compiled against a stub closure so the rollback
// runs exactly as it does in screen.js (no re-implementation / hollow test).
const seekSrc = grab(/function _svHandleSeek\(newTime\) \{[\s\S]*?\n    \}/, '_svHandleSeek');

// Drive the real seek over a set of already-judged notes. `notes` are judge
// entries { noteKey, t, hand }; `hitKeys` are the noteKeys claimed as hits, the
// rest of the swept region being miss dots. Returns the post-seek counters.
function runSeek(notes, hitKeys, missKeys, counters, newTime, wrongKeyMissTimes = []) {
    const missEntryByKey = new Map(notes.map((n) => [n.noteKey, n]));
    const harness = `"use strict";
        const HIT_TOLERANCE_S = 0.1;
        let _svJudgeNotesAll = A.notes;
        const _svMissEntryByKey = A.missEntryByKey;
        const _svMissNotes = new Set(A.missKeys);
        const _svHitNoteKeys = new Set(A.hitKeys);
        const _svWrongKeyMissTimes = A.wrongKeyMissTimes.slice();
        const _svClearOnSeek = true;   // default; miss-dot rollback is gated on it (#16)
        let _svMissSweepIdx = 0;
        let _svHits = A.c.hits, _svMisses = A.c.misses;
        let _svHitsRH = A.c.hitsRH, _svMissesRH = A.c.missesRH;
        let _svHitsLH = A.c.hitsLH, _svMissesLH = A.c.missesLH;
        function _svRedrawAllMissDots() {}
        function _svUpdateScoreBadge() {}
        ${seekSrc}
        _svHandleSeek(A.newTime);
        return {
            hits: _svHits, misses: _svMisses,
            hitsRH: _svHitsRH, missesRH: _svMissesRH,
            hitsLH: _svHitsLH, missesLH: _svMissesLH,
            missDots: _svMissNotes.size, hitClaims: _svHitNoteKeys.size,
            wrongKeyMisses: _svWrongKeyMissTimes.length,
        };`;
    return new Function('A', harness)({ notes, missEntryByKey, hitKeys, missKeys, c: counters, newTime, wrongKeyMissTimes });
}

// ── _svAccuracyPct ───────────────────────────────────────────────────────────

test('_svAccuracyPct is 0 when nothing has been judged (no divide-by-zero)', () => {
    assert.equal(_svAccuracyPct(0, 0), 0);
});

test('_svAccuracyPct is 100 for all hits, 0 for all misses', () => {
    assert.equal(_svAccuracyPct(10, 0), 100);
    assert.equal(_svAccuracyPct(0, 5), 0);
});

test('_svAccuracyPct matches hits / (hits + misses) * 100', () => {
    assert.equal(_svAccuracyPct(3, 1), 75);
    assert.equal(_svAccuracyPct(1, 3), 25);
    assert.equal(_svAccuracyPct(1, 1), 50);
});

test('_svAccuracyPct returns a real number for non-terminating ratios', () => {
    // 2/3 → 66.666…%; the badge rounds for display, the helper does not.
    assert.ok(Math.abs(_svAccuracyPct(2, 1) - (2 / 3) * 100) < 1e-9);
});

// ── _svHandleSeek counter rollback (backward seek / replay) ──────────────────

test('backward seek rewinds hit and miss tallies (per hand + combined)', () => {
    // Four notes: RH-hit, RH-miss, LH-hit, LH-miss, all at/after the seek time.
    const notes = [
        { noteKey: 'a', t: 1.0, hand: 0 },
        { noteKey: 'b', t: 1.5, hand: 0 },
        { noteKey: 'c', t: 2.0, hand: 1 },
        { noteKey: 'd', t: 2.5, hand: 1 },
    ];
    // Tallies as if all four were scored: 2 hits (a,c), 2 misses (b,d).
    const c = { hits: 2, misses: 2, hitsRH: 1, missesRH: 1, hitsLH: 1, missesLH: 1 };
    const out = runSeek(notes, ['a', 'c'], ['b', 'd'], c, 0.5);
    // Everything at/after 0.5 rolls back — counters return to their prior zero.
    assert.deepEqual(
        { hits: out.hits, misses: out.misses, hitsRH: out.hitsRH,
          missesRH: out.missesRH, hitsLH: out.hitsLH, missesLH: out.missesLH },
        { hits: 0, misses: 0, hitsRH: 0, missesRH: 0, hitsLH: 0, missesLH: 0 });
    assert.equal(out.missDots, 0, 'miss dots cleared');
    assert.equal(out.hitClaims, 0, 'hit claims cleared');
});

test('seek only rolls back notes at/after the new time; earlier scores stay', () => {
    const notes = [
        { noteKey: 'a', t: 1.0, hand: 0 },   // before seek — keep
        { noteKey: 'b', t: 3.0, hand: 1 },   // after seek — roll back
    ];
    const c = { hits: 1, misses: 1, hitsRH: 1, missesRH: 0, hitsLH: 0, missesLH: 1 };
    const out = runSeek(notes, ['a'], ['b'], c, 2.0);
    assert.equal(out.hits, 1, 'earlier hit kept');
    assert.equal(out.hitsRH, 1);
    assert.equal(out.misses, 0, 'later miss rolled back');
    assert.equal(out.missesLH, 0);
    assert.equal(out.missDots, 0);
    assert.equal(out.hitClaims, 1);
});

test('backward seek rolls back wrong-key misses (combined denominator only)', () => {
    // Two wrong-key presses: one before the seek (t=1.0, keep) and one after
    // (t=3.0, roll back). No chart notes involved — pure extra misses.
    const c = { hits: 0, misses: 2, hitsRH: 0, missesRH: 0, hitsLH: 0, missesLH: 0 };
    const out = runSeek([], [], [], c, 2.0, [1.0, 3.0]);
    assert.equal(out.misses, 1, 'only the post-seek wrong-key miss rolled back');
    assert.equal(out.wrongKeyMisses, 1, 'stale time pruned, earlier one kept');
    assert.equal(out.missesRH, 0, 'per-hand tallies untouched by wrong-key misses');
    assert.equal(out.missesLH, 0);
});

test('rollback never drives a counter negative on a double seek', () => {
    const notes = [{ noteKey: 'a', t: 2.0, hand: 0 }];
    // Counters already at zero (region cleared by a prior seek) but the entry
    // still names t>=newTime — must clamp at 0, not underflow.
    const c = { hits: 0, misses: 0, hitsRH: 0, missesRH: 0, hitsLH: 0, missesLH: 0 };
    const out = runSeek(notes, [], ['a'], c, 1.0);
    assert.equal(out.misses, 0);
    assert.equal(out.missesRH, 0);
});
