/**
 * ============================================================
 *  SPEED JUDGMENT EXPERIMENT  –  2AFC "which video was faster?"
 *  Built with jsPsych 7.x
 *
 *  Design (within-participant):
 *    • Each trial = ONE PAIR of videos shown side by side (left / right),
 *      played SEQUENTIALLY (first one, then the other).
 *    • STANDARD video : chargeSpeed 5.25, sound condition 'same'
 *    • TEST video     : 7 speeds × 3 sound conditions
 *                       - 2 repetitions per cell
 *                       - 6 repetitions for intermediate speeds (4, 5.25, 6.5)
 *    • Trial count    : (4 speeds × 3 sounds × 2) + (3 speeds × 3 sounds × 6)
 *                       = 24 + 54 = 78 pairs  (156 video presentations)
 *    • Counterbalanced within each (speed × sound) cell:
 *         - TEMPORAL order  : test-first vs standard-first (50/50)
 *         - SPATIAL side    : test-left vs test-right      (50/50)
 *         - dot COLOR       : black vs grey                (50/50; matched
 *                             within a pair so the two videos differ only in
 *                             speed and sound)
 *    • ISI is stratified within every cell, so the ISI distribution is matched
 *      across sound conditions and across speed levels by construction.
 *
 *  Response per trial: binary choice (LEFT vs RIGHT video was faster)
 *                      + confidence 0–100.
 *
 *  Per-trial data logged: see buildTidyTrials() for the exact column list.
 *
 *  Data saving: POST to the lab server in saveAndReturn().
 * ============================================================
 */

// ── CDN globals (loaded via <script> tags in index.html) ─────────────────────
// jsPsych 7.x CDN exposes initJsPsych directly as a global — no redeclaration needed.
// Plugin globals follow the pattern jsPsych<PluginName>:
const htmlKeyboardResponse = jsPsychHtmlKeyboardResponse;
const surveyHtmlForm       = jsPsychSurveyHtmlForm;
const surveyMultiChoice    = jsPsychSurveyMultiChoice;
const surveyMultiSelect    = jsPsychSurveyMultiSelect;
const fullscreen           = jsPsychFullscreen;
const CallFunctionPlugin   = jsPsychCallFunction;
const htmlButtonResponse   = jsPsychHtmlButtonResponse;  // mouse-click responses

// ── Trial metadata ────────────────────────────────────────────────────────────
// trialMetadata must be defined before this script runs.
//   var trialMetadata = [ { trialID, chargeSpeed, left_color, repetition,
//                           avgCDelay, ISI_ms, touch_time_2_s, ... }, ... ];
if (typeof trialMetadata === 'undefined') {
    console.warn('trialMetadata not found — using empty array. Load trial_metadata.js first.');
    var trialMetadata = [];
}

// Module-level jsPsych instance — assigned inside runExperiment() before any
// trial builders are called, so all functions below can reference it safely.
var jsPsych;



// ════════════════════════════════════════════════════════════
//  1.  EXPERIMENT PARAMETERS
// ════════════════════════════════════════════════════════════

// ── Debug mode ───────────────────────────────────────────────
// DEBUG = 1 runs a short 3-pair version; DEBUG = 0 is the full experiment.
const DEBUG = 1;

// Speed levels and which ones get extra repetitions.
// NOTE: 6.5 (not 6.75) is the level present in SPEED_LEVELS — see the note in
// the accompanying summary. Change here if the stimulus set really uses 6.75.
const SPEED_LEVELS        = [1.5, 2.75, 4, 5.25, 6.5, 7.75, 9];
const INTERMEDIATE_SPEEDS = new Set([4, 5.25, 6.5]);   // oversampled

const BASE_REPS           = 2;   // reps per (speed × sound) cell
const INTERMEDIATE_REPS   = 6;   // reps for intermediate speeds

// The standard (reference) video that appears on EVERY trial.
const STANDARD_SPEED = 5.25;
const STANDARD_SOUND = 'same';

const SOUND_CONDITIONS  = ['higher', 'same', 'lower'];
const COLORS            = ['black', 'grey'];

// Video base path — relative to index.html location
const VIDEO_BASE_PATH   = './videos';

// Number of blocks. 78 pairs / 6 blocks = 13 pairs per block.
const N_BLOCKS          = DEBUG ? 1 : 6;

// ── Pair-presentation timing (ms) ────────────────────────────
const PRE_STIM_DELAY  = 300;   // blank/static period before the first video
const INTER_VIDEO_GAP = 600;   // static gap between the two videos
const POST_STIM_DELAY = 300;   // static period after the second video

// ── Nuisance-variable option ─────────────────────────────────
// false (default): the standard's ISI is drawn from a stratified deck that is
//   independent of the test condition, so ISI cannot confound the sound/speed
//   effects; ISI_test, ISI_standard and their difference are logged as covariates.
// true: the standard is chosen to have the ISI closest to the test video's,
//   removing the within-pair ISI difference as a discriminative cue at the cost
//   of tying the standard's ISI to the test condition.
const MATCH_ISI_WITHIN_PAIR = false;



// ════════════════════════════════════════════════════════════
//  2.  UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════

/** Fisher-Yates shuffle (in-place). Returns the array for convenience. */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Shuffle a copy without mutating the original. */
function shuffled(arr) { return shuffle([...arr]); }

/** Build the video file path from a sound condition and trialID. */
function videoPath(soundCondition, trialID) {
    return `${VIDEO_BASE_PATH}/${soundCondition}/${trialID}.mp4`;
}

/** Number of repetitions for a given test speed. */
function repsForSpeed(speed) {
    return INTERMEDIATE_SPEEDS.has(speed) ? INTERMEDIATE_REPS : BASE_REPS;
}

/**
 * stratifiedSampleByISI(candidates, n)
 * ------------------------------------
 * Draws `n` rows spread evenly across the ISI distribution of `candidates`:
 * the pool is sorted by ISI, split into `n` equal-width strata, and one row is
 * drawn at random from each stratum.
 *
 * Why: it guarantees the ISI distribution is (near-)identical for every
 * (speed × sound) cell — which is the counterbalancing requirement — while
 * still varying the specific exemplars across participants.
 *
 * Falls back to sampling with replacement if the pool is smaller than n.
 */
function stratifiedSampleByISI(candidates, n) {
    if (!candidates || candidates.length === 0) return [];

    const sorted = [...candidates].sort((a, b) => a.ISI_ms - b.ISI_ms);

    // Pool too small: cycle through it (with a shuffle) so we still return n rows.
    if (sorted.length < n) {
        console.warn(`Only ${sorted.length} candidates for ${n} slots — sampling with replacement.`);
        const out = [];
        while (out.length < n) out.push(...shuffled(sorted));
        return out.slice(0, n);
    }

    const out = [];
    for (let s = 0; s < n; s++) {
        const lo = Math.floor((s       * sorted.length) / n);
        const hi = Math.floor(((s + 1) * sorted.length) / n);   // exclusive
        const stratum = sorted.slice(lo, Math.max(hi, lo + 1));
        out.push(stratum[Math.floor(Math.random() * stratum.length)]);
    }
    return out;
}

/**
 * balancedOrderSide(nReps, cellIndex)
 * -----------------------------------
 * Returns nReps {order, side} assignments where
 *   order = 1  ->  the TEST video plays FIRST
 *   order = 2  ->  the TEST video plays SECOND
 *   side  = 'left' | 'right'  ->  where the TEST video sits on screen
 *
 * Within each cell both marginals are exactly balanced (half/half). Because
 * nReps is 2 or 6 (never a multiple of 4), the order×side *pairing* cannot also
 * be balanced inside every cell, so the two aliasing directions are alternated
 * across cells via `cellIndex` (offset by a random per-session parity) —
 * leaving the four order×side combinations equally frequent across the whole
 * session, and the aliasing direction unbiased across participants.
 */
// Random per-session parity for the order x side aliasing direction (see
// balancedOrderSide). Without it the aliasing would point the same way for
// every participant, turning a within-participant nuisance into a design-level
// one; flipping it per session leaves it unbiased across the sample.
const SESSION_PARITY = Math.random() < 0.5 ? 0 : 1;

function balancedOrderSide(nReps, cellIndex) {
    const ALL4 = [
        { order: 1, side: 'left'  },
        { order: 1, side: 'right' },
        { order: 2, side: 'left'  },
        { order: 2, side: 'right' },
    ];

    const out = [];
    // Full crossings first (0 for nReps=2, 1 for nReps=6).
    for (let k = 0; k < Math.floor(nReps / 4); k++) out.push(...ALL4.map(o => ({ ...o })));

    // Remainder is always 2 for nReps ∈ {2, 6}: add one aligned or one
    // anti-aligned pair, alternating by cellIndex.
    const rem = nReps % 4;
    if (rem === 2) {
        out.push(...((cellIndex + SESSION_PARITY) % 2 === 0
            ? [{ order: 1, side: 'left'  }, { order: 2, side: 'right' }]
            : [{ order: 1, side: 'right' }, { order: 2, side: 'left'  }]));
    } else if (rem !== 0) {
        // Defensive: odd nReps can't be balanced; deal from the 4-combo deck.
        for (let k = 0; k < rem; k++) out.push({ ...ALL4[(cellIndex + SESSION_PARITY + k) % 4] });
    }

    return shuffle(out);
}

/** Balanced color list for a cell: half black, half grey (colors matched within a pair). */
function balancedColors(nReps) {
    const out = [];
    for (let i = 0; i < nReps; i++) out.push(COLORS[i % COLORS.length]);
    return shuffle(out);
}



// ════════════════════════════════════════════════════════════
//  3.  PAIR CONSTRUCTION WITH ISI / SIDE / ORDER COUNTERBALANCING
// ════════════════════════════════════════════════════════════

/**
 * buildStimulusPool()
 * -------------------
 * Groups usable trialMetadata rows by (chargeSpeed × left_color).
 * Returns: Map<`${speed}_${color}`, row[]>
 */
function buildStimulusPool() {
    const pool = new Map();
    for (const row of trialMetadata) {
        // Skip incomplete trials (missing second touch time = no valid video)
        if (row.touch_time_2_s === null || row.touch_time_2_s === undefined) {
            console.warn(`Skipping incomplete trial: ${row.trialID}`);
            continue;
        }
        const key = `${row.chargeSpeed}_${row.left_color}`;
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push({ ...row });
    }
    return pool;
}

/**
 * dealISIAcrossSounds(candidates, nPerSound, soundOrder, reverse)
 * --------------------------------------------------------------
 * Draws `nPerSound × 3` ISI-stratified exemplars from `candidates` and deals
 * them round-robin across the three sound conditions by ISI rank.
 *
 * `reverse` flips the rank order. Calling this once per color with
 * reverse = false for one color and true for the other makes the ISI ranks
 * assigned to each sound condition mirror-symmetric, so the mean (and roughly
 * the whole distribution) of ISI is matched across sound conditions within
 * every speed level — which is the counterbalancing requirement. The plain
 * round-robin alone would leave sound conditions sitting at different points
 * of the ISI distribution, and with only 2 reps per cell there is no room to
 * fix that within a cell.
 *
 * Worked example, 2 reps per cell (nPerSound = 1, so 3 ranks per color):
 *   black : sound A <- rank 0,  sound B <- rank 1,  sound C <- rank 2
 *   grey  : sound A <- rank 2,  sound B <- rank 1,  sound C <- rank 0
 *   => mean rank = 1 for all three sound conditions.
 *
 * `soundOrder` is shuffled once per speed level (and shared by both colors) so
 * the specific rank-to-condition mapping varies across participants.
 *
 * Returns: { higher: row[], same: row[], lower: row[] }
 */
function dealISIAcrossSounds(candidates, nPerSound, soundOrder, reverse) {
    const N     = nPerSound * soundOrder.length;
    const strat = stratifiedSampleByISI(candidates, N);      // ascending ISI
    const ranks = reverse ? [...strat].reverse() : strat;

    const out = {};
    soundOrder.forEach(s => { out[s] = []; });
    for (let i = 0; i < N; i++) out[soundOrder[i % soundOrder.length]].push(ranks[i]);
    return out;
}

/**
 * buildPairList(pool)
 * -------------------
 * Builds the full list of 78 pair-trials.
 *
 * Structure:
 *   • nReps per (speed × sound) cell = 2, or 6 for intermediate speeds.
 *   • Color is balanced within each cell and MATCHED within a pair, so the two
 *     videos on a trial differ only in speed and sound level.
 *   • Temporal order (test first / second) and spatial side (test left / right)
 *     are balanced within each cell by balancedOrderSide().
 *   • Test exemplars: ISI-stratified and dealt across sound conditions with
 *     mirrored ranks per color (see dealISIAcrossSounds), so test ISI is matched
 *     across sound conditions at every speed level.
 *   • Standard exemplars: drawn from the (5.25 × 'same' × matching color) pool
 *     using the same mirrored deal, so the standard's ISI is also uncorrelated
 *     with the test condition. Never the same exemplar as the test video.
 *
 * Returns: pairTrial[]  (unshuffled; blocking happens in buildBlocks)
 */
function buildPairList(pool) {
    const pairs = [];
    let cellIndex = 0;

    for (const speed of SPEED_LEVELS) {
        const nReps      = repsForSpeed(speed);
        const nPerSound  = nReps / 2;                       // per sound, per color
        const soundOrder = shuffled(SOUND_CONDITIONS);      // shared by both colors

        // ── Draw test and standard exemplars for this speed level ────────────
        // reverse = false for the first color, true for the second: this is what
        // makes ISI mirror-symmetric across sound conditions.
        const testPlan = {};      // testPlan[color][sound] = row[]
        const stdPlan  = {};      // stdPlan[color][sound]  = row[]

        COLORS.forEach((color, ci) => {
            const testCands = pool.get(`${speed}_${color}`) ?? [];
            const stdCands  = pool.get(`${STANDARD_SPEED}_${color}`) ?? [];
            if (testCands.length === 0) console.warn(`No test candidates for ${speed}_${color}.`);
            if (stdCands.length  === 0) console.warn(`No standard candidates for ${STANDARD_SPEED}_${color}.`);

            testPlan[color] = dealISIAcrossSounds(testCands, nPerSound, soundOrder, ci === 1);
            stdPlan[color]  = dealISIAcrossSounds(stdCands,  nPerSound, soundOrder, ci === 1);
        });

        for (const sound of SOUND_CONDITIONS) {
            const orderSide = balancedOrderSide(nReps, cellIndex);
            const colorList = balancedColors(nReps);
            cellIndex++;

            const cursor = {};   // per-color read position into the planned draws

            for (let r = 0; r < nReps; r++) {
                const color = colorList[r];
                const k     = (cursor[color] = (cursor[color] ?? 0));
                cursor[color] = k + 1;

                const test = testPlan[color][sound]?.[k];
                if (!test) { console.warn(`Missing test exemplar for ${speed}_${sound}_${color}.`); continue; }

                const standard = pickStandard(pool, color, test, stdPlan[color][sound]?.[k]);
                if (!standard) { console.warn(`Missing standard for ${speed}_${sound}_${color}.`); continue; }

                const { order, side } = orderSide[r];

                // Resolve the two videos into temporal (1st/2nd) and spatial (L/R) slots.
                const testInfo = {
                    trialID : test.trialID,
                    speed   : test.chargeSpeed,
                    sound   : sound,
                    ISI_ms  : test.ISI_ms,
                    src     : videoPath(sound, test.trialID),
                    role    : 'test',
                };
                const stdInfo = {
                    trialID : standard.trialID,
                    speed   : standard.chargeSpeed,
                    sound   : STANDARD_SOUND,
                    ISI_ms  : standard.ISI_ms,
                    src     : videoPath(STANDARD_SOUND, standard.trialID),
                    role    : 'standard',
                };

                const first  = order === 1 ? testInfo : stdInfo;   // plays first
                const second = order === 1 ? stdInfo  : testInfo;  // plays second
                const left   = side === 'left'  ? testInfo : stdInfo;
                const right  = side === 'left'  ? stdInfo  : testInfo;

                pairs.push({
                    pairID       : `${speed}_${sound}_${color}_r${r + 1}`,
                    // Condition
                    testSpeed    : test.chargeSpeed,
                    testSound    : sound,
                    color,
                    repetition   : r + 1,
                    // Exemplars
                    testTrialID     : test.trialID,
                    standardTrialID : standard.trialID,
                    testISI_ms      : test.ISI_ms,
                    standardISI_ms  : standard.ISI_ms,
                    isiDiff_ms      : test.ISI_ms - standard.ISI_ms,
                    // Counterbalancing
                    testPosition : order,     // 1 = test played first, 2 = second
                    testSide     : side,      // 'left' | 'right'
                    // Slot assignment used by the player
                    first, second, left, right,
                    // Ground truth for the speed judgment (null when speeds are equal)
                    testObjectivelyFaster : test.chargeSpeed === STANDARD_SPEED
                        ? null
                        : (test.chargeSpeed > STANDARD_SPEED ? 1 : 0),
                });
            }
        }
    }

    return pairs;
}

/**
 * pickStandard(pool, color, test, planned)
 * ----------------------------------------
 * Returns the standard exemplar for one trial.
 *
 * MATCH_ISI_WITHIN_PAIR = false (default): use the pre-planned, ISI-balanced
 *   draw. If it happens to be the same exemplar as the test video (only possible
 *   in the speed 5.25 × 'same' cell), substitute the nearest-ISI alternative so
 *   the ISI balancing is disturbed as little as possible.
 * MATCH_ISI_WITHIN_PAIR = true: ignore the plan and pick the exemplar whose ISI
 *   is closest to the test video's, removing the within-pair ISI difference as a
 *   discriminative cue.
 */
function pickStandard(pool, color, test, planned) {
    const cands = (pool.get(`${STANDARD_SPEED}_${color}`) ?? []).filter(c => c.trialID !== test.trialID);
    if (cands.length === 0) return null;

    if (MATCH_ISI_WITHIN_PAIR) {
        return cands.reduce((best, c) =>
            Math.abs(c.ISI_ms - test.ISI_ms) < Math.abs(best.ISI_ms - test.ISI_ms) ? c : best);
    }

    if (planned && planned.trialID !== test.trialID) return planned;

    // Collision with the test exemplar: nearest ISI substitute.
    const targetISI = planned ? planned.ISI_ms : test.ISI_ms;
    return cands.reduce((best, c) =>
        Math.abs(c.ISI_ms - targetISI) < Math.abs(best.ISI_ms - targetISI) ? c : best);
}

/**
 * buildBlocks(pairs)
 * ------------------
 * Splits the pairs into N_BLOCKS blocks of equal size (78 / 6 = 13).
 *
 * Trials are dealt cell-by-cell into blocks via a single running counter, so
 * every condition is spread as evenly as possible across blocks rather than
 * clumping into one — otherwise time-on-task (fatigue, criterion drift) could
 * correlate with condition. Trials are then shuffled within each block, and
 * block order is shuffled.
 *
 * Returns: { blocks: pair[][], allVideoSrcs: string[] }
 */
function buildBlocks(pairs) {
    if (DEBUG) {
        const debugPairs = shuffled(pairs).slice(0, 3);
        debugPairs.forEach((p, i) => { p.block = 1; p.trialInBlock = i + 1; });
        console.warn(`DEBUG MODE: running ${debugPairs.length} pair(s) only.`);
        return {
            blocks: [debugPairs],
            allVideoSrcs: debugPairs.flatMap(p => [p.first.src, p.second.src]),
        };
    }

    // Group by (speed × sound) cell, shuffled cell order and shuffled within cell.
    const cells = new Map();
    for (const p of pairs) {
        const key = `${p.testSpeed}_${p.testSound}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(p);
    }
    const cellLists = shuffled([...cells.values()]).map(shuffled);

    // One running counter across all cells keeps block sizes exactly equal
    // while spreading each cell's trials across different blocks.
    const blocks = Array.from({ length: N_BLOCKS }, () => []);
    let counter = 0;
    for (const cellList of cellLists) {
        for (const p of cellList) blocks[counter++ % N_BLOCKS].push(p);
    }

    blocks.forEach(b => shuffle(b));
    shuffle(blocks);

    // Stamp block / trial position for logging.
    let n = 0;
    blocks.forEach((b, bi) => b.forEach((p, ti) => {
        p.block        = bi + 1;
        p.trialInBlock = ti + 1;
        p.trialIndex   = ++n;
    }));

    const allVideoSrcs = blocks.flat().flatMap(p => [p.first.src, p.second.src]);
    return { blocks, allVideoSrcs };
}

/** Convenience wrapper used by runExperiment(). */
function buildTrialList() {
    const pool  = buildStimulusPool();
    const pairs = buildPairList(pool);
    console.log(`Built ${pairs.length} pair-trials (expected 78 in the full design).`);
    return buildBlocks(pairs);
}



// ════════════════════════════════════════════════════════════
//  4.  VIDEO PRELOADING
// ════════════════════════════════════════════════════════════

/**
 * preloadVideos(videoSrcList)
 * ---------------------------
 * Injects hidden <video> elements and resolves when all have buffered.
 *
 * ⚠️  BROWSER NOTE: Chrome and Safari may block autoplay even when muted in
 *     some contexts. Preloading is muted (always permitted); the *experiment*
 *     videos are unmuted and rely on the user gesture from the volume-adjust
 *     Play button and the per-trial button clicks. Test Chrome, Firefox, Safari.
 */
function preloadVideos(videoSrcList) {
    const uniqueSrcs = [...new Set(videoSrcList)];
    const BATCH_SIZE = 10; // load 10 at a time to avoid Chrome throttling

    function loadBatch(srcs) {
        const container = document.getElementById('videoPreloadContainer');
        return Promise.all(srcs.map(src => new Promise((resolve) => {
            const vid         = document.createElement('video');
            vid.src           = src;
            vid.preload       = 'auto';
            vid.muted         = true;
            vid.style.display = 'none';
            container.appendChild(vid);

            const done = () => resolve();
            vid.addEventListener('canplaythrough', done, { once: true });
            vid.addEventListener('error',          done, { once: true });
            setTimeout(done, 10000); // 10 s per-video fallback
            vid.load();
        })));
    }

    async function runBatches() {
        for (let i = 0; i < uniqueSrcs.length; i += BATCH_SIZE) {
            const batch = uniqueSrcs.slice(i, i + BATCH_SIZE);
            await loadBatch(batch);
            console.log(`Preloaded ${Math.min(i + BATCH_SIZE, uniqueSrcs.length)} / ${uniqueSrcs.length}`);
        }
    }

    return runBatches();
}



// ════════════════════════════════════════════════════════════
//  5.  PAIR PLAYBACK TRIAL
// ════════════════════════════════════════════════════════════

/**
 * pairStimulusHTML()
 * ------------------
 * Static markup for the two side-by-side video slots plus a status line.
 * Styles are inline so no stylesheet changes are needed.
 * Each slot is 44vw wide (capped at 620 px), which fits two 4:3 videos on a
 * 1280 px-wide laptop screen with room for the highlight border.
 */
function pairStimulusHTML() {
    return `
        <div id="pairContainer" style="
            display:flex; justify-content:center; align-items:flex-start;
            gap:2vw; width:100%;">
            <div class="pair-slot" id="slot-left" style="
                border:6px solid transparent; border-radius:8px; padding:2px;">
                <div style="text-align:center; font-size:0.95em; color:#666;
                            letter-spacing:1px; margin-bottom:4px;">LEFT</div>
                <video id="vid-left" preload="auto" playsinline
                       style="width:44vw; max-width:620px; height:auto;
                              background:#fff; display:block;"></video>
            </div>
            <div class="pair-slot" id="slot-right" style="
                border:6px solid transparent; border-radius:8px; padding:2px;">
                <div style="text-align:center; font-size:0.95em; color:#666;
                            letter-spacing:1px; margin-bottom:4px;">RIGHT</div>
                <video id="vid-right" preload="auto" playsinline
                       style="width:44vw; max-width:620px; height:auto;
                              background:#fff; display:block;"></video>
            </div>
        </div>`;
}

/**
 * buildPairTrial(pair)
 * --------------------
 * Plays the two videos of one pair sequentially while BOTH remain on screen.
 *
 * Sequence:
 *   PRE_STIM_DELAY  -> highlight + play video 1 -> ('ended')
 *   INTER_VIDEO_GAP -> highlight + play video 2 -> ('ended')
 *   POST_STIM_DELAY -> finishTrial()
 *
 * Timing notes:
 *   • Advancing on the 'ended' event (not a fixed trial_duration) means a slow
 *     frame or a late start can't truncate a video.
 *   • A stall watchdog per video (duration + 4 s, or 20 s if duration is
 *     unknown) guarantees the trial always advances if a video errors or hangs.
 *   • The non-playing video is seeked to t = 0 so it shows its first frame
 *     (two stationary dots) rather than an empty black rectangle.
 *   • Both videos are UNMUTED. Only one plays at a time, so the two contact
 *     sounds are never overlapped.
 *   • All timestamps are performance.now() offsets from trial start, logged for
 *     post-hoc checks on playback integrity.
 */
function buildPairTrial(pair) {
    return {
        type                : htmlKeyboardResponse,
        stimulus            : pairStimulusHTML(),
        choices             : 'NO_KEYS',
        response_ends_trial : false,
        trial_duration      : null,   // ends when the sequence completes
        data: {
            task            : 'pair_playback',
            pairID          : pair.pairID,
            block           : pair.block ?? null,
            trialInBlock    : pair.trialInBlock ?? null,
            testSpeed       : pair.testSpeed,
            testSound       : pair.testSound,
            color           : pair.color,
            repetition      : pair.repetition,
            testTrialID     : pair.testTrialID,
            standardTrialID : pair.standardTrialID,
            testISI_ms      : pair.testISI_ms,
            standardISI_ms  : pair.standardISI_ms,
            isiDiff_ms      : pair.isiDiff_ms,
            testPosition    : pair.testPosition,   // 1 = played first
            testSide        : pair.testSide,       // 'left' | 'right'
            leftRole        : pair.left.role,
            rightRole       : pair.right.role,
            firstRole       : pair.first.role,
            leftTrialID     : pair.left.trialID,
            rightTrialID    : pair.right.trialID,
            testObjectivelyFaster : pair.testObjectivelyFaster,
        },
        on_load: function () {
            const t0       = performance.now();
            const vLeft    = document.getElementById('vid-left');
            const vRight   = document.getElementById('vid-right');
            const sLeft    = document.getElementById('slot-left');
            const sRight   = document.getElementById('slot-right');

            // Map spatial slots to sources.
            vLeft.src  = pair.left.src;
            vRight.src = pair.right.src;

            // Which element plays first / second (temporal order).
            const firstIsLeft = pair.first.role === pair.left.role;
            const seq = firstIsLeft
                ? [{ vid: vLeft,  slot: sLeft  }, { vid: vRight, slot: sRight }]
                : [{ vid: vRight, slot: sRight }, { vid: vLeft,  slot: sLeft  }];

            // Show the first frame of each video instead of a black rectangle.
            [vLeft, vRight].forEach(v => {
                v.muted = false;
                v.controls = false;
                v.addEventListener('loadeddata', () => {
                    try { v.currentTime = 0; } catch (e) { /* seek not ready */ }
                }, { once: true });
                v.load();
            });

            // Collected for logging.
            const marks = {};
            this._pairMarks   = marks;
            this._pairTimers  = [];       // so on_finish can clear pending timers

            const HIGHLIGHT = '#1f6fd0';

            const schedule = (fn, ms) => {
                const id = setTimeout(fn, ms);
                this._pairTimers.push(id);
                return id;
            };

            /** Play one video, then call `next()` once it ends (or stalls). */
            const playOne = (index, next) => {
                const { vid, slot } = seq[index];
                let advanced = false;

                const finishStep = (reason) => {
                    if (advanced) return;
                    advanced = true;
                    slot.style.borderColor = 'transparent';
                    marks[`v${index + 1}_end_ms`]  = performance.now() - t0;
                    marks[`v${index + 1}_end_why`] = reason;
                    next();
                };

                slot.style.borderColor = HIGHLIGHT;
                marks[`v${index + 1}_start_ms`] = performance.now() - t0;

                vid.addEventListener('ended', () => finishStep('ended'), { once: true });
                vid.addEventListener('error', () => finishStep('error'), { once: true });

                // Guard the seek: setting currentTime before metadata is loaded
                // throws InvalidStateError in some browsers.
                try { vid.currentTime = 0; } catch (e) { /* not seekable yet */ }
                vid.play().catch(err => {
                    // Autoplay refusal: log it and let the watchdog move things on
                    // so a participant is never stuck on a silent screen.
                    console.warn('Video play() rejected:', err.name, err.message, vid.src);
                    marks[`v${index + 1}_play_rejected`] = err.name;
                });

                // Stall watchdog — always advances the trial.
                const dur = Number.isFinite(vid.duration) && vid.duration > 0
                    ? vid.duration * 1000 + 4000
                    : 20000;
                schedule(() => finishStep('timeout'), dur);
            };

            // Run the sequence.
            schedule(() => {
                playOne(0, () => {
                    schedule(() => {
                        playOne(1, () => {
                            schedule(() => {
                                marks.total_ms = performance.now() - t0;
                                jsPsych.finishTrial(marks);
                            }, POST_STIM_DELAY);
                        });
                    }, INTER_VIDEO_GAP);
                });
            }, PRE_STIM_DELAY);
        },
        on_finish: function () {
            // Clear any watchdog timers still pending so they can't fire into a
            // later trial, and restore the cursor for the upcoming click responses.
            (this._pairTimers ?? []).forEach(clearTimeout);
            this._pairTimers = null;
            this._pairMarks  = null;
            document.body.style.cursor = 'auto';
        },
    };
}



// ════════════════════════════════════════════════════════════
//  6.  RESPONSE & CONFIDENCE TRIALS
// ════════════════════════════════════════════════════════════

/**
 * buildSpeedResponseTrial()
 * -------------------------
 * Binary forced choice via MOUSE: which of the two videos was faster?
 * Buttons are LEFT/RIGHT and map onto the spatial slots, so no label
 * randomisation is needed — the mapping is intrinsic to the display, and side
 * bias is handled by counterbalancing which side the TEST video occupies.
 *
 * jsPsych logs `response` as the clicked button index (0 = left, 1 = right)
 * and `rt` automatically. on_finish recodes to the analysis fields; it reads
 * `testSide` / `testObjectivelyFaster`, which buildMainExperiment() merges into
 * each copy's `data` object.
 */
function buildSpeedResponseTrial() {
    return {
        type     : htmlButtonResponse,
        stimulus : `
            <p style="font-size:1.15em;">Which video was <strong>faster</strong>?</p>
            <p style="color:#666;">Click your choice below.</p>`,
        choices             : ['The LEFT video was faster', 'The RIGHT video was faster'],
        response_ends_trial : true,
        trial_duration      : null,   // wait indefinitely for a click
        data                : { task: 'speed_response' },
        on_finish: function (data) {
            const side = data.response === 0 ? 'left' : 'right';
            data.response_side = side;
            // Primary DV: did the participant pick the TEST video as faster?
            data.chose_test = (side === data.testSide) ? 1 : 0;
            // Accuracy, defined only when the two speeds actually differ.
            data.correct = (data.testObjectivelyFaster === null || data.testObjectivelyFaster === undefined)
                ? null
                : (data.chose_test === data.testObjectivelyFaster ? 1 : 0);
        },
    };
}

/**
 * buildConfidenceTrial()
 * ----------------------
 * Confidence 0–100 via MOUSE only. Participant clicks anywhere on the track
 * (or drags the handle) to set a value, then clicks "Confirm".
 *
 * The Confirm button stays disabled until the participant interacts with the
 * slider at least once, so a default/un-set rating is never logged.
 *
 * Final value is logged as `confidence_rating` (0–100). Document-level pointer
 * listeners are removed on finish so they can't leak into later trials.
 */
function buildConfidenceTrial() {
    return {
        type                : htmlButtonResponse,
        stimulus: `
            <div style="text-align:center;">
                <p>How confident are you in your response?</p>
                <div class="confidence-slider-wrapper">
                    <div class="confidence-track" id="conf-track">
                        <div class="confidence-handle" id="conf-handle" style="left:50%;"></div>
                    </div>
                    <div class="confidence-labels">
                        <span>Not at all confident</span>
                        <span>Very confident</span>
                    </div>
                </div>
                <p style="margin-top:14px;">Click or drag the slider, then press Confirm.</p>
                <p class="movement-warning" id="conf-warning">Please set the slider before confirming.</p>
            </div>`,
        choices             : ['Confirm'],
        button_html         : '<button class="jspsych-btn" disabled id="conf-confirm-btn">%choice%</button>',
        response_ends_trial : true,
        trial_duration      : null,
        data                : { task: 'confidence_rating' },
        on_load: function () {
            let position = 50;       // 0–100; not yet "set" by the participant
            let hasMoved = false;
            let dragging = false;

            const handle  = document.getElementById('conf-handle');
            const track   = document.getElementById('conf-track');
            const warning = document.getElementById('conf-warning');
            const confirm = document.getElementById('conf-confirm-btn');

            function positionFromEvent(e) {
                const rect = track.getBoundingClientRect();
                const x    = e.clientX - rect.left;
                return Math.max(0, Math.min(1, x / rect.width)) * 100;
            }

            function applyPosition(pct) {
                position = pct;
                handle.style.left = `${pct}%`;
                if (!hasMoved) {
                    hasMoved = true;
                    warning.style.display = 'none';
                    confirm.disabled = false;   // unlock Confirm on first interaction
                }
            }

            track.addEventListener('pointerdown', (e) => {
                dragging = true;
                applyPosition(positionFromEvent(e));
            });

            // Listen on document so the drag survives the pointer leaving the track.
            this._confMoveHandler = (e) => {
                if (!dragging) return;
                applyPosition(positionFromEvent(e));
            };
            this._confUpHandler = () => { dragging = false; };

            document.addEventListener('pointermove', this._confMoveHandler);
            document.addEventListener('pointerup',   this._confUpHandler);

            this._getConfidence = () => position;
        },
        on_finish: function (data) {
            data.confidence_rating = this._getConfidence ? this._getConfidence() : null;

            if (this._confMoveHandler) document.removeEventListener('pointermove', this._confMoveHandler);
            if (this._confUpHandler)   document.removeEventListener('pointerup',   this._confUpHandler);
            this._confMoveHandler = null;
            this._confUpHandler   = null;
            this._getConfidence   = null;
        },
    };
}

/** Short blank-screen inter-trial interval (100 ms) so screens don't flash. */
function buildITI() {
    return {
        type                : htmlKeyboardResponse,
        stimulus            : ' ',
        trial_duration      : 100,
        response_ends_trial : false,
        choices             : 'NO_KEYS',
    };
}



// ════════════════════════════════════════════════════════════
//  7.  PRACTICE TRIALS
// ════════════════════════════════════════════════════════════

/**
 * buildPracticePairs()
 * --------------------
 * Three practice pairs against the standard, all with sound 'same':
 *   test speed 1.5 (clearly slower), 9 (clearly faster), 5.25 (ambiguous).
 * Sides and temporal orders are varied across the three so the participant
 * doesn't learn a position rule.
 */
function buildPracticePairs(pool) {
    const configs = [
        { speed: 1.5,  side: 'left',  order: 1 },
        { speed: 9,    side: 'right', order: 2 },
        { speed: 5.25, side: 'right', order: 1 },
    ];

    const out = [];
    for (const [i, cfg] of configs.entries()) {
        const color   = COLORS[i % COLORS.length];
        const testC   = pool.get(`${cfg.speed}_${color}`) ?? [];
        const stdC    = pool.get(`${STANDARD_SPEED}_${color}`) ?? [];
        const test    = testC[Math.floor(Math.random() * testC.length)];
        const std     = stdC.find(c => c.trialID !== test?.trialID) ?? stdC[0];

        if (!test || !std) {
            console.warn(`Practice pair ${i + 1} unavailable (speed ${cfg.speed}, color ${color}).`);
            continue;
        }

        const testInfo = { trialID: test.trialID, speed: test.chargeSpeed, sound: 'same',
                           ISI_ms: test.ISI_ms, src: videoPath('same', test.trialID), role: 'test' };
        const stdInfo  = { trialID: std.trialID,  speed: std.chargeSpeed,  sound: STANDARD_SOUND,
                           ISI_ms: std.ISI_ms,  src: videoPath(STANDARD_SOUND, std.trialID), role: 'standard' };

        out.push({
            pairID       : `practice_${i + 1}`,
            testSpeed    : test.chargeSpeed,
            testSound    : 'same',
            color,
            repetition   : 1,
            testTrialID     : test.trialID,
            standardTrialID : std.trialID,
            testISI_ms      : test.ISI_ms,
            standardISI_ms  : std.ISI_ms,
            isiDiff_ms      : test.ISI_ms - std.ISI_ms,
            testPosition : cfg.order,
            testSide     : cfg.side,
            first  : cfg.order === 1 ? testInfo : stdInfo,
            second : cfg.order === 1 ? stdInfo  : testInfo,
            left   : cfg.side === 'left' ? testInfo : stdInfo,
            right  : cfg.side === 'left' ? stdInfo  : testInfo,
            testObjectivelyFaster : test.chargeSpeed === STANDARD_SPEED
                ? null : (test.chargeSpeed > STANDARD_SPEED ? 1 : 0),
        });
    }
    return out;
}

/**
 * buildPracticeBlock(practicePairs)
 * ---------------------------------
 * Instruction screen + the practice pairs, each tagged isPractice:true so
 * buildTidyTrials() can exclude them.
 */
function buildPracticeBlock(practicePairs) {
    const respTrial = buildSpeedResponseTrial();
    const confTrial = buildConfidenceTrial();

    const timeline = [
        {
            type    : surveyHtmlForm,
            preamble: `
                <h2>Practice</h2>
                <p>You will now do ${practicePairs.length} practice trials to get familiar with the task.</p>
                <p>On each trial, two videos appear side by side. One plays, then the other —
                   a highlighted border shows which one is playing.</p>
                <p>Afterwards you will be asked in which video, the two dots moved <strong>faster</strong> when they started 
                    to move towards each other, and then how <strong>confident</strong> you are in that judgment.</p>
                <p>Please keep watching both videos and do not adjust your volume.</p>`,
            html         : ' ',
            button_label : 'Begin Practice',
            response_ends_trial: true,
        },
    ];

    for (const pair of practicePairs) {
        const pairTrial = buildPairTrial(pair);
        const meta = { testSide: pair.testSide, testObjectivelyFaster: pair.testObjectivelyFaster };

        timeline.push(
            { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'none'; } },
            { ...pairTrial, data: { ...pairTrial.data, isPractice: true } },
            buildITI(),
            { ...respTrial, data: { ...respTrial.data, ...meta, isPractice: true } },
            buildITI(),
            { ...confTrial, data: { ...confTrial.data, isPractice: true } },
            buildITI(),
        );
    }

    timeline.push({ type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'auto'; } });
    return timeline;
}



// ════════════════════════════════════════════════════════════
//  8.  MAIN EXPERIMENT BLOCK BUILDER
// ════════════════════════════════════════════════════════════

/**
 * buildMainExperiment(blocks)
 * ---------------------------
 * Assembles the main timeline from the pre-built pair blocks. Each block opens
 * with a brief reminder and (except after the last block) closes with a break.
 *
 * The identifying metadata the response trial needs for its on_finish recoding
 * (testSide, testObjectivelyFaster) plus the main condition columns are merged
 * into each response/confidence copy's `data`, so every logged row is
 * self-identifying and no post-hoc merge is required.
 */
function buildMainExperiment(blocks) {
    const respTrial = buildSpeedResponseTrial();
    const confTrial = buildConfidenceTrial();
    const trials    = [];

    for (let b = 0; b < blocks.length; b++) {
        trials.push({
            type    : surveyHtmlForm,
            preamble: `
                <p><strong>Block ${b + 1} of ${blocks.length}</strong></p>
                <p>Two videos will appear side by side and play one after the other.
                   The highlighted border shows which one is playing.</p>
                <p> Decide which video contains the <strong>faster</strong> dots when they started 
                    to move towards each other, then rate how confident you are.</p>`,
            html         : ' ',
            button_label : b === 0 ? 'Begin Experiment' : 'Continue',
            response_ends_trial: true,
        });

        for (const pair of blocks[b]) {
            const pairTrial = buildPairTrial(pair);

            // Stamp condition identity onto the response and confidence rows too.
            const trialMeta = {
                pairID          : pair.pairID,
                block           : pair.block,
                testSpeed       : pair.testSpeed,
                testSound       : pair.testSound,
                color           : pair.color,
                testTrialID     : pair.testTrialID,
                standardTrialID : pair.standardTrialID,
                testPosition    : pair.testPosition,
                testSide        : pair.testSide,
                testObjectivelyFaster : pair.testObjectivelyFaster,
            };

            trials.push(
                { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'none'; } },
                pairTrial,
                buildITI(),
                { ...respTrial, data: { ...respTrial.data, ...trialMeta } },
                buildITI(),
                { ...confTrial, data: { ...confTrial.data, ...trialMeta } },
                buildITI(),
            );
        }

        if (b < blocks.length - 1) {
            trials.push({
                type    : surveyHtmlForm,
                preamble: '<p>Feel free to take a short break. Press "Continue" when ready.</p>',
                html    : ' ',
                button_label: 'Continue',
                response_ends_trial: true,
                on_load: function () { document.body.style.cursor = 'auto'; },
            });
        }
    }

    return trials;
}



// ════════════════════════════════════════════════════════════
//  9a.  SOUND (LOUDNESS) DISCRIMINATION CHECK
// ════════════════════════════════════════════════════════════

/**
 * buildSoundCheck()
 * -----------------
 * End-of-experiment manipulation check: verifies participants can actually
 * discriminate the +/-6 dB sound levels used in the videos.
 *
 * Three forced-choice trials, one per condition pair:
 *     same vs lower  |  same vs higher  |  lower vs higher
 * Each trial plays ONE pre-baked file containing both bursts (A -> gap -> B);
 * the participant clicks whether the FIRST or SECOND sound was softer.
 *
 * Counterbalancing: for each pair we randomly pick which order-variant file to
 * play, so "softer" isn't always in the same position; trial order is shuffled.
 *
 * The two choice buttons start DISABLED and unlock only after the pair has
 * finished playing once, so a response always reflects having heard both.
 * Replays are allowed and counted. The Play-button click is the user gesture
 * that satisfies browser autoplay policy (same pattern as buildVolumeAdjust).
 *
 * Data (task:'sound_check'): pair, first_condition, second_condition,
 *   softer_position (1|2), response_position (1|2), correct (0|1), n_replays, rt
 *
 * Requires the WAVs from generate_sound_check.py in SOUND_CHECK_BASE_PATH.
 */
const SOUND_CHECK_BASE_PATH = './soundCheckAudios';
const SC_LEVEL = { lower: 0, same: 1, higher: 2 };  // relative rank -> softer position

function buildSoundCheck() {
    const pairs = [
        { pair: 'same_vs_lower',   a: 'same',  b: 'lower'  },
        { pair: 'same_vs_higher',  a: 'same',  b: 'higher' },
        { pair: 'lower_vs_higher', a: 'lower', b: 'higher' },
    ];

    // One jsPsych trial per pair; pair order shuffled, presentation order randomised.
    const trials = shuffled(pairs).map(({ pair, a, b }) => {
        const [first, second] = Math.random() < 0.5 ? [a, b] : [b, a];
        const src       = `${SOUND_CHECK_BASE_PATH}/check_${first}_${second}.wav`;
        const softerPos = SC_LEVEL[first] < SC_LEVEL[second] ? 1 : 2;

        return {
            type: htmlButtonResponse,
            stimulus: `
                <div style="text-align:center;">
                    <p>You will hear <strong>two sounds</strong>, one after the other.</p>
                    <p><strong>Which sound was softer (quieter)?</strong></p>
                    <audio id="sc-audio" src="${src}" preload="auto"></audio>
                    <button type="button" id="sc-play" class="jspsych-btn" style="margin:10px 0;">
                        ▶ Play the two sounds
                    </button>
                    <p id="sc-status" style="font-size:0.9em; color:#666; min-height:1.2em;">
                        Click Play to hear the two sounds.
                    </p>
                </div>`,
            // Choice buttons render DISABLED; unlocked after first full playback.
            choices     : ['First sound was softer', 'Second sound was softer'],
            button_html : '<button class="jspsych-btn sc-choice" disabled>%choice%</button>',
            response_ends_trial: true,
            trial_duration     : null,
            data: {
                task            : 'sound_check',
                pair,
                first_condition : first,
                second_condition: second,
                softer_position : softerPos,
            },
            on_load: function () {
                const audioEl = document.getElementById('sc-audio');
                const playBtn = document.getElementById('sc-play');
                const status  = document.getElementById('sc-status');
                const choices = document.querySelectorAll('.sc-choice');

                let played   = false;   // has the pair finished at least once?
                let nReplays = 0;       // count plays after the first

                playBtn.addEventListener('click', function () {
                    if (played) nReplays++;          // every click after the first = a replay
                    audioEl.currentTime = 0;
                    audioEl.play()
                        .then(()  => { status.textContent = 'Playing…'; })
                        .catch(e => {
                            console.warn('Sound-check playback blocked:', e);
                            status.textContent = 'Playback was blocked — click Play again.';
                        });
                });

                // Unlock the response buttons the FIRST time the pair finishes.
                audioEl.addEventListener('ended', function () {
                    played = true;
                    choices.forEach(btn => { btn.disabled = false; });
                    status.textContent = 'Now choose which sound was softer. (You may replay.)';
                });

                this._getReplays = () => nReplays;   // expose to on_finish
            },
            on_finish: function (data) {
                // data.response is the clicked button index (0 = first, 1 = second).
                const responsePos      = data.response === 0 ? 1 : 2;
                data.response_position = responsePos;
                data.correct           = responsePos === data.softer_position ? 1 : 0;
                data.n_replays         = this._getReplays ? this._getReplays() : 0;
                this._getReplays       = null;
            },
        };
    });

    // Intro screen (also gives the tiny WAVs a moment to buffer before trial 1).
    const intro = {
        type    : surveyHtmlForm,
        preamble: `
            <h2>One last listening task</h2>
            <p>On each of the next <strong>three</strong> trials you will hear two sounds
               played one after the other, with a short gap between them.</p>
            <p>Decide <strong>which sound was softer</strong> — the first or the second.
               Press Play, then click your answer.</p>`,
        html    : ' ',
        button_label      : 'Start',
        response_ends_trial: true,
    };

    return [intro, ...trials];
}




// ════════════════════════════════════════════════════════════
//  9b.  DEMOGRAPHIC SURVEY
// ════════════════════════════════════════════════════════════

function buildDemographicSurvey() {
    return [
        {
            type    : surveyHtmlForm,
            preamble: '<p>Thank you for finishing the experiment! Please answer a few questions to complete the study.</p>',
            html    : ' ',
            button_label: 'Continue',
            response_ends_trial: true,
        },
        {
            type : surveyMultiChoice,
            data : { task: 'demographic' },
            questions: [
                // Cover-story check removed — there is no cover story in this version.
                {
                    prompt    : '<strong>Did you notice the sound changes when the two dots contact each other?</strong>',
                    name      : 'sound_awareness',
                    options   : ['Yes, sometimes louder', 'Yes, sometimes softer', 'Yes, sometimes louder and sometimes softer', 'No change noticed'],
                    required  : true,
                    horizontal: true,
                },
                {
                    prompt    : '<strong>Did the contact sound influence your speed judgments?</strong>',
                    name      : 'sound_influence',
                    options   : ['Yes, deliberately', 'Maybe, without intending to', 'No', 'Not sure'],
                    required  : true,
                    horizontal: true,
                },
                {
                    prompt    : '<strong>How difficult did you find the speed comparison?</strong>',
                    name      : 'task_difficulty',
                    options   : ['Very easy', 'Somewhat easy', 'Neither', 'Somewhat difficult', 'Very difficult'],
                    required  : true,
                    horizontal: true,
                },
            ],
        },
        {
            type : surveyMultiChoice,
            // task:'demographic' lets buildDemographics() collect every answer
            // with one filter instead of digging through rawData.
            data : { task: 'demographic' },
            questions: [
                {
                    prompt    : '<strong>How would you describe your gender?</strong>',
                    name      : 'gender',
                    options   : ['Male', 'Female', 'Non-binary / Other', 'Prefer not to say'],
                    required  : true,
                    horizontal: true,
                },
                {
                    prompt    : '<strong>Are you of Hispanic or Latinx origin?</strong>',
                    name      : 'hispanic',
                    options   : ['Yes', 'No', 'Unknown / Prefer not to say'],
                    required  : true,
                    horizontal: true,
                },
            ],
        },
        {
            type : surveyMultiSelect,
            data : { task: 'demographic' },
            questions: [{
                prompt  : '<strong>How would you describe your race?</strong>',
                name    : 'race',
                options : [
                    'American Indian / Alaska Native',
                    'Asian',
                    'Native Hawaiian or Other Pacific Islander',
                    'Black or African American',
                    'White',
                    'More than one race',
                    'Unknown / Prefer not to say',
                ],
                required  : true,
                horizontal: false,
            }],
        },
        {
            type    : surveyHtmlForm,
            data    : { task: 'demographic' },
            preamble: '',
            html: `
                <p style="text-align:left;">
                    <strong>Age:</strong><br>
                    <input type="number" name="age" min="18" max="99"
                        style="width:80px; margin-top:4px;"><br><br>
                    <strong>Location (US state, optional):</strong><br>
                    <input type="text" name="location" style="width:200px; margin-top:4px;">
                </p>`,
        },
        {
            type    : surveyHtmlForm,
            data    : { task: 'demographic' },
            preamble: '<p style="text-align:left;"><strong>Did you use any strategies to complete the task? (optional)</strong></p>',
            html: `
                <input type="text" name="strategy" style="width:500px;"><br><br>
                <p style="text-align:left;"><strong>Any other feedback about the task? (optional)</strong></p>
                <input type="text" name="feedback" style="width:500px;">`,
        },
        {
            type    : surveyHtmlForm,
            preamble: `<p>In case you are curious: we are investigating how sound affects the
                        perceived speed of moving objects. The two dots moved at different speeds
                        across videos, and the sound that accompanied their contact was sometimes
                        louder and sometimes softer. We are testing whether a louder contact sound
                        makes the same motion look faster.</p>`,
            html    : ' ',
            button_label: 'Continue',
            response_ends_trial: true,
        },
    ];
}

/**
 * buildDemographics()
 * -------------------
 * Flattens all task:'demographic' survey responses into one object,
 * e.g. { sound_awareness, gender, hispanic, race, age, location, ... }.
 * surveyMultiSelect returns arrays (e.g. race) — joined with '; ' for a flat cell.
 */
function buildDemographics() {
    const rows = jsPsych.data.get().filter({ task: 'demographic' }).values();
    const demo = {};
    for (const row of rows) {
        const resp = row.response;
        if (!resp || typeof resp !== 'object') continue;
        for (const [key, val] of Object.entries(resp)) {
            demo[key] = Array.isArray(val) ? val.join('; ') : val;
        }
    }
    return demo;
}



// ════════════════════════════════════════════════════════════
//  10.  HEADPHONE CHECK
// ════════════════════════════════════════════════════════════

/**
 * buildHeadphoneCheck()
 * ----------------------
 * Wraps the McDermott Lab HeadphoneCheck library in a jsPsych trial.
 * Participants who fail are shown a warning and the experiment ends.
 * Requires jQuery and HeadphoneCheck.min.js loaded in index.html.
 *
 * NOTE: the original file defined this function twice; the second definition
 * silently overrode the first. Only this one remains.
 */
function buildHeadphoneCheck() {
    const checkTrial = {
        type               : htmlKeyboardResponse,
        stimulus           : '<div id="hc-container"></div>',
        choices            : 'NO_KEYS',
        response_ends_trial: false,
        trial_duration     : null,
        data               : { task: 'headphone_check' },
        on_load: function () {
            $(document).off('hcHeadphoneCheckEnd');   // clear any stale listener
            $(document).on('hcHeadphoneCheckEnd', function (event, data) {
                $(document).off('hcHeadphoneCheckEnd');
                jsPsych.finishTrial({
                    hc_passed      : data.didPass,
                    hc_totalCorrect: data.data.totalCorrect,
                    hc_numTrials   : data.data.stimIDList.length,
                });
            });
            HeadphoneCheck.runHeadphoneCheck({ doCalibration: false });
        },
    };

    const failTrial = {
        type    : htmlKeyboardResponse,
        stimulus: `<p>Unfortunately, you did not pass the headphone check.</p>
                   <p>This experiment requires headphones. Please try again
                   using headphones and ensure your volume is turned up.</p>`,
        choices       : 'NO_KEYS',
        trial_duration: 5000,
        on_finish     : () => jsPsych.endExperiment('Ended: failed headphone check.'),
    };

    return [
        checkTrial,
        {
            timeline            : [failTrial],
            conditional_function: function () {
                const last = jsPsych.data.get().last(1).values()[0];
                return last?.hc_passed === false;
            },
        },
    ];
}



// ════════════════════════════════════════════════════════════
//  11.  PROLIFIC, CONSENT & INSTRUCTIONS
// ════════════════════════════════════════════════════════════

function buildPreExperiment(jsPsych) {
    return [
        // Prolific ID — only ask manually if it wasn't captured from the URL.
        {
            timeline: [
                {
                    type    : surveyHtmlForm,
                    preamble: '<p>Please enter your <strong>Prolific ID</strong> to begin.</p>',
                    html    : '<input id="prolific_id" type="text" name="prolific_id" size="40" required>',
                    on_finish: function (data) {
                        const typed = data.response?.prolific_id;
                        if (typed) jsPsych.data.addProperties({ subject_id: typed });
                    },
                },
            ],
            conditional_function: function () {
                const existing = jsPsych.data.get().values()[0]?.subject_id;
                return !existing;
            },
        },
        // Consent
        {
            type    : surveyHtmlForm,
            preamble: `
                <u>DARTMOUTH COLLEGE: CONSENT TO ACT AS A RESEARCH SUBJECT</u>

                <p>Professor Störmer, Ph.D. is conducting a research study to find out more about
                perception, attention and memory. Please read the information below, and ask questions
                about anything you do not understand, before deciding whether or not to participate.</p>

                <p>Your participation in this research is completely voluntary. If you choose to
                participate, you may subsequently withdraw from the study at any time without penalty
                or consequences of any kind. If you choose not to participate, your relationship with
                Dartmouth College and your right to health care or other services to which you are
                otherwise entitled will not be affected. The investigator may withdraw you from this
                research if circumstances arise which warrant doing so.</p>

                <p><strong>PURPOSE OF THE STUDY:</strong> To examine human perception and cognition.
                Perception is what puts us in contact with our present surroundings, while cognition
                is what makes us able to form beliefs, make decisions, and so on. All data from this
                experiment is gathered for scientific purposes and will contribute to our understanding
                of brain and sensory function. These data may be published in scientific journals so
                that other researchers may have access to these data.</p>

                <p><strong>PROCEDURES.</strong> If you agree to participate in this study by accepting
                this agreement and continuing in the task, the following will happen to you:<br>
                1. You will be shown displays of letters, words, or pictures, right here in your web browser.<br>
                2. You will try to perceive and remember these stimuli, and respond by pressing keys or
                moving and clicking the mouse in a manner that we will describe to you.</p>

                <p><strong>RISKS.</strong> You will be required only to continue to interact with your
                web browser and make responses for a short duration. Thus, no potential risks or
                discomforts are anticipated except for the possibility that some tasks may be slightly
                boring. However, there may be risks that are currently unforeseeable.</p>

                <p><strong>BENEFITS:</strong> There are no direct benefits to the subjects who
                participate except the knowledge they gain about the scientific goals and outcomes of
                the experiment. The investigator may learn about perception and attention of different
                types of stimuli, and society may benefit from this knowledge.</p>

                <p><strong>RISKS:</strong> The effects of participating should be comparable to those
                you would experience from viewing television or a computer monitor and using a mouse
                or keyboard. As with all research there is also the possibility of loss of
                confidentiality. We have taken steps to minimize the effects.</p>

                <p><strong>CONFIDENTIALITY:</strong> Research records will be kept confidential to
                the extent allowed by law. Data from participants such as yourself will be identified
                by subject number, which is not associated with your identity. Names and other
                identifying information will not be used in any presentation or paper written about
                this project. Data will be stored on password-protected computers to which only the
                experimenters have access. After the data is no longer required, physical copies of
                the data will be shredded and electronic copies will be overwritten so as to make
                sure they are never recoverable.</p>

                <p><strong>PAYMENT:</strong> In consideration of your time, you will receive payment
                at the rate described through the recruitment system, in either course credit or
                monetary renumeration. Compensation will range from $2 (for a 10 min task) up to as
                much as $24 (for a task that takes 120 min), with rates of $12/hr. The exact payment
                rate for this task is provided in the task description.</p>

                <p>If you have questions about the research, you may reach Dr. Störmer at
                viola.s.stoermer@Dartmouth.edu or 617-895-7407.</p>

                <p>If you have questions, concerns, complaints, or suggestions about human research
                at Dartmouth, you may call the Office of the Committee for the Protection of Human
                Subjects at Dartmouth College (603) 646-6482 during normal business hours.</p>

                <p>By checking the box below and clicking Continue, you are indicating that you are
                at least 18 years old, have read this consent form and agree to participate in this
                research study. Please print a copy of this page for your records.</p>`,
            html    : '<input type="checkbox" id="consent" required> <strong>I Consent to Participate</strong>',
        },
        // ── Task instructions (no cover story) ─────────────────────────────────
        {
            type    : surveyHtmlForm,
            preamble: `
                <h2>Experiment Instructions</h2>
                <p style="text-align:left;">In this study you will watch short videos of
                <strong>two dots</strong> that move toward each other and make contact.
                A sound accompanies the moment of contact.</p>

                <p style="text-align:left;">On each trial, <strong>two videos</strong> appear side by
                side — one on the left and one on the right. They play <strong>one after the other</strong>,
                and a highlighted border shows which video is currently playing.</p>

                <p style="text-align:left;">Your task is to decide which video contains the <strong>faster</strong>
                dots when they start to move to each other. After both videos have played, click
                <strong>LEFT</strong> or <strong>RIGHT</strong>, then indicate how confident you are
                in your judgment using the slider.</p>

                <p style="text-align:left;">The difference can be subtle. Please watch both videos
                carefully on every trial and answer as accurately as you can.</p>`,
            html         : ' ',
            button_label : 'Continue',
            response_ends_trial: true,
        },
        // Device / environment
        {
            type    : surveyHtmlForm,
            preamble: '<p><strong>This experiment requires you to be in a quiet environment.</strong></p>' +
                      '<p>Please turn off any music, podcasts, or other audio before continuing.</p>' +
                      `<p>Please put on your headphones. If you do not have headphones, you can use earbuds. 
                        Please make sure you are wearing earbuds or headphones without noise cancellation.</p>`,
            html         : ' ',
            button_label : 'Done — Continue',
            response_ends_trial: true,
        },
        // Full-screen
        {
            type           : fullscreen,
            fullscreen_mode: true,
            message        : '<p>The experiment will now enter full-screen mode.</p>',
            button_label   : 'Enter Full Screen',
        },
    ];
}

// ════════════════════════════════════════════════════════════
//  11b.  VOLUME ADJUSTMENT  (runs AFTER the headphone check)
// ════════════════════════════════════════════════════════════

/**
 * buildVolumeAdjust()
 * -------------------
 * Lets the participant play a sample sound (unlimited replays) to set a
 * comfortable volume. Placed after the headphone check so they have already
 * confirmed headphones are connected before tuning their level.
 *
 * The Play-button click also acts as the user gesture that unlocks audio
 * autoplay for all subsequent video trials.
 */
function buildVolumeAdjust() {
    return [
        {
            type    : surveyHtmlForm,
            preamble: `
                <h2>Audio Setup</h2>
                <p>Now that your headphones are set up, play the sound below and adjust your
                volume following the instructions.</p>
                <p> 1. Turn your volume down to where you almost can't hear the noise.<br>
                    2. Then slowly turn the volume down just a little more until you can't hear the noise any more.<br>
                    3. Then turn it up a tiny bit until you can just barely hear the noise.</p>
                <p><strong>Please keep the volume as you have it now and do not make any adjustments/changes throughout the experiment!</strong></p>
                <p>When you are ready, click the button below to continue.</p>`,
            html    : `
                <audio id="volume-check-audio" src="volume_adjust.wav" preload="auto"></audio>
                <button type="button" id="play-volume-check" class="jspsych-btn"
                        style="margin: 10px 0; font-size: 1.05em;">
                    ▶ Play sound
                </button>
                <p id="volume-check-status" style="font-size: 0.9em; color: #666; min-height: 1.2em;"></p>`,
            button_label: 'Done — Continue',
            response_ends_trial: true,
            on_load: function () {
                const audioEl = document.getElementById('volume-check-audio');
                const playBtn = document.getElementById('play-volume-check');
                const status  = document.getElementById('volume-check-status');

                playBtn.addEventListener('click', function () {
                    audioEl.currentTime = 0;
                    const playPromise = audioEl.play();
                    if (playPromise !== undefined) {
                        playPromise
                            .then(()  => { status.textContent = 'Playing…'; })
                            .catch(e => {
                                console.warn('Audio playback blocked:', e);
                                status.textContent =
                                    'Playback was blocked by your browser. Click Play again.';
                            });
                    }
                });

                audioEl.addEventListener('ended', function () {
                    status.textContent = 'Finished — click Play to hear it again.';
                });
            },
            on_finish: function () {
                // Silent-buffer unlock as a fallback for subsequent video trials.
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    const buf = ctx.createBuffer(1, 1, 22050);
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);
                    src.start(0);
                } catch (e) {
                    console.warn('AudioContext unlock failed:', e);
                }
            },
        },
    ];
}



// ════════════════════════════════════════════════════════════
//  12.  REFRESH RATE CHECK
// ════════════════════════════════════════════════════════════

function buildRefreshRateCheck() {
    const checkTrial = {
        type          : htmlKeyboardResponse,
        stimulus      : '<p>Checking display refresh rate — please wait…</p>',
        choices       : 'NO_KEYS',
        trial_duration: 1200,
        on_start: function (trial) {
            let frames = 0;
            const t0   = performance.now();

            function tick() {
                frames++;
                if (performance.now() - t0 < 1000) {
                    requestAnimationFrame(tick);
                } else {
                    const hz = frames / ((performance.now() - t0) / 1000);
                    jsPsych.data.addProperties({ refresh_rate_hz: hz });
                    trial.data = { refresh_rate_hz: hz };
                }
            }
            requestAnimationFrame(tick);
        },
    };

    const failScreen = {
        type    : htmlKeyboardResponse,
        stimulus: `<p>Your screen's refresh rate appears to be below 40 Hz.</p>
                   <p>A higher refresh rate is needed for accurate video playback.
                   Please exit and try on a different device.</p>`,
        choices       : 'NO_KEYS',
        trial_duration: 5000,
        on_finish     : () => jsPsych.endExperiment('Terminated: low refresh rate.'),
    };

    return [
        checkTrial,
        {
            timeline            : [failScreen],
            conditional_function: function () {
                const last = jsPsych.data.get().last(1).values()[0];
                return (last?.refresh_rate_hz ?? 60) < 40;
            },
        },
    ];
}



// ════════════════════════════════════════════════════════════
//  12b.  TIDY TRIAL TABLE (one row per pair)
// ════════════════════════════════════════════════════════════

/**
 * buildTidyTrials()
 * -----------------
 * Walks the raw jsPsych data in presentation order and consolidates each
 * experimental trial — which spans THREE jsPsych rows (pair_playback →
 * speed_response → confidence_rating) — into a SINGLE tidy row.
 *
 * One row per presented pair; practice trials are excluded. Anchors on each
 * pair_playback row and reads forward to the next response and confidence rows,
 * so intervening ITI rows don't matter.
 *
 * Output columns (see tidyTrialsToCSV for the canonical order):
 *   id, trial_number, block, pairID,
 *   testSpeed, testSound, color, repetition,
 *   testTrialID, standardTrialID, testISI_ms, standardISI_ms, isiDiff_ms,
 *   testPosition, testSide,
 *   response_side, chose_test, testObjectivelyFaster, correct, response_rt,
 *   confidence, confidence_rt,
 *   v1_start_ms, v1_end_ms, v2_start_ms, v2_end_ms, playback_ok
 */
function buildTidyTrials() {
    const all = jsPsych.data.get().values();

    const participantId = all.find(r => r.subject_id)?.subject_id ?? null;

    const tidy = [];
    let trialNumber = 0;

    for (let i = 0; i < all.length; i++) {
        const row = all[i];
        if (row.task !== 'pair_playback') continue;
        if (row.isPractice) continue;

        let responseRow   = null;
        let confidenceRow = null;
        for (let j = i + 1; j < all.length; j++) {
            const next = all[j];
            if (next.task === 'pair_playback') break;   // reached the next trial
            if (next.task === 'speed_response'    && !responseRow)   responseRow   = next;
            if (next.task === 'confidence_rating' && !confidenceRow) confidenceRow = next;
            if (responseRow && confidenceRow) break;
        }

        trialNumber += 1;

        tidy.push({
            id           : participantId,
            trial_number : trialNumber,
            block        : row.block  ?? null,
            pairID       : row.pairID ?? null,
            // Condition
            testSpeed    : row.testSpeed  ?? null,
            testSound    : row.testSound  ?? null,
            color        : row.color      ?? null,
            repetition   : row.repetition ?? null,
            // Exemplars and ISI covariates
            testTrialID     : row.testTrialID     ?? null,
            standardTrialID : row.standardTrialID ?? null,
            testISI_ms      : row.testISI_ms      ?? null,
            standardISI_ms  : row.standardISI_ms  ?? null,
            isiDiff_ms      : row.isiDiff_ms      ?? null,
            // Counterbalancing factors (needed as nuisance predictors)
            testPosition : row.testPosition ?? null,   // 1 = test played first
            testSide     : row.testSide     ?? null,   // 'left' | 'right'
            // Response — primary DV is chose_test
            response_side         : responseRow?.response_side ?? null,
            chose_test            : responseRow?.chose_test    ?? null,
            testObjectivelyFaster : row.testObjectivelyFaster ?? null,
            correct               : responseRow?.correct ?? null,
            response_rt           : responseRow?.rt      ?? null,
            // Confidence
            confidence    : confidenceRow?.confidence_rating ?? null,
            confidence_rt : confidenceRow?.rt ?? null,
            // Playback integrity diagnostics
            v1_start_ms : row.v1_start_ms ?? null,
            v1_end_ms   : row.v1_end_ms   ?? null,
            v2_start_ms : row.v2_start_ms ?? null,
            v2_end_ms   : row.v2_end_ms   ?? null,
            // 1 only if BOTH videos ended naturally (no timeout / error / autoplay block)
            playback_ok : (row.v1_end_why === 'ended' && row.v2_end_why === 'ended'
                           && !row.v1_play_rejected && !row.v2_play_rejected) ? 1 : 0,
        });
    }

    return tidy;
}

/**
 * tidyTrialsToCSV(rows)
 * ---------------------
 * Converts the buildTidyTrials() array into a CSV string with a header row.
 * Values are quoted and internal quotes escaped (RFC 4180 style).
 */
function tidyTrialsToCSV(rows) {
    const columns = [
        'id', 'trial_number', 'block', 'pairID',
        'testSpeed', 'testSound', 'color', 'repetition',
        'testTrialID', 'standardTrialID', 'testISI_ms', 'standardISI_ms', 'isiDiff_ms',
        'testPosition', 'testSide',
        'response_side', 'chose_test', 'testObjectivelyFaster', 'correct', 'response_rt',
        'confidence', 'confidence_rt',
        'v1_start_ms', 'v1_end_ms', 'v2_start_ms', 'v2_end_ms', 'playback_ok',
    ];
    const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return `"${s.replace(/"/g, '""')}"`;
    };
    const header = columns.map(escape).join(',');
    const body   = rows.map(r => columns.map(c => escape(r[c])).join(',')).join('\n');
    return `${header}\n${body}`;
}



// ════════════════════════════════════════════════════════════
//  13.  DATA SAVING & PROLIFIC REDIRECT
// ════════════════════════════════════════════════════════════

/**
 * saveAndReturn(startExperimentTime)
 * ----------------------------------
 * Collects all relevant trial and session data, POSTs it to the Dartmouth lab
 * server, then redirects to Prolific.
 *
 * ⚠️  Update experimentName and the Prolific completion code before each study.
 */
function saveAndReturn(startExperimentTime) {
    const endTime   = new Date();
    const totalTime = endTime - startExperimentTime;

    // trials:       one row per real (non-practice) pair -> pd.DataFrame(curData.trials)
    // demographics: one flat object of survey answers     -> pd.DataFrame([curData.demographics])
    const trials       = buildTidyTrials();
    const demographics = buildDemographics();

    const hcData = jsPsych.data.get().filter({ task: 'headphone_check' }).values()[0];

    const soundCheck = jsPsych.data.get().filter({ task: 'sound_check' }).values()
        .map(r => ({
            pair: r.pair, first_condition: r.first_condition, second_condition: r.second_condition,
            softer_position: r.softer_position, response_position: r.response_position,
            correct: r.correct, n_replays: r.n_replays, rt: r.rt,
        }));

    const refreshRate = jsPsych.data.get().values()
                          .find(d => d.refresh_rate_hz)?.refresh_rate_hz ?? null;

    const subject_id = jsPsych.data.get().values()[0]?.subject_id ?? null;
    const study_id   = jsPsych.data.get().values()[0]?.study_id   ?? null;
    const session_id = jsPsych.data.get().values()[0]?.session_id ?? null;

    Object.assign(demographics, {
        subject_id, study_id, session_id,
        institution     : 'Prolific',
        begTime         : startExperimentTime,
        endTime,
        totalTime,
        experimentName  : 'audiovisual_speedjudgment',   // ⚠️ update per study
        debug           : DEBUG,
        nBlocks         : N_BLOCKS,
        nTrials         : trials.length,
        standardSpeed   : STANDARD_SPEED,
        standardSound   : STANDARD_SOUND,
        isiMatchedWithinPair : MATCH_ISI_WITHIN_PAIR,
        windowWidth     : window.innerWidth,
        windowHeight    : window.innerHeight,
        screenWidth     : screen.width,
        screenHeight    : screen.height,
        refreshRate,
        hc_passed       : hcData?.hc_passed       ?? null,
        hc_totalCorrect : hcData?.hc_totalCorrect ?? null,
        hc_numTrials    : hcData?.hc_numTrials     ?? null,
        sc_totalCorrect : soundCheck.filter(r => r.correct === 1).length,
        sc_numTrials    : soundCheck.length,
        // Exclusion-relevant summary: how many trials had clean playback.
        nPlaybackOK     : trials.filter(t => t.playback_ok === 1).length,
    });

    trials.forEach(t => { t.subject_id = subject_id; });

    const curData = {
        trials,
        soundCheck,
        demographics,
        // Raw jsPsych dump kept ONLY in debug, to keep the live file small.
        ...(DEBUG ? { rawData: jsPsych.data.get().values() } : {}),
    };

    const dataToServer = {
        id             : subject_id ?? ('anon_' + Date.now()),
        experimenter   : 'YF',
        experimentName : DEBUG
                           ? 'audiovisual_socialfrommotion_exp2_DEBUG'
                           : 'audiovisual_socialfrommotion_exp2',   // ⚠️ update per study
        curData        : JSON.stringify(curData),
    };

    $.post(
        'https://rcweb.dartmouth.edu/StoermerLab/save.php',
        dataToServer,
        function () {
            // ⚠️ Update the Prolific completion code for each new study
            window.location.href = 'https://app.prolific.com/submissions/complete?cc=XXXXXXXX';
        }
    ).fail(function () {
        console.error('Data save failed — redirecting anyway.');
        window.location.href = 'https://app.prolific.com/submissions/complete?cc=XXXXXXXX';
    });
}



// ════════════════════════════════════════════════════════════
//  14.  MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════

async function runExperiment() {

    const startExperimentTime = new Date();

    jsPsych = initJsPsych({
        override_safe_mode : true,
        show_progress_bar  : true,
        on_finish: function () {
            if (DEBUG) {
                const csv  = tidyTrialsToCSV(buildTidyTrials());
                const blob = new Blob([csv], { type: 'text/csv' });
                const a    = document.createElement('a');
                a.href     = URL.createObjectURL(blob);
                a.download = 'debug_data_tidy.csv';
                a.click();
                URL.revokeObjectURL(a.href);
                console.log('DEBUG: tidy data saved to debug_data_tidy.csv');
            }
            saveAndReturn(startExperimentTime);
        },
        on_error: function (err) {
            console.error('jsPsych error:', err);
        },
    });

    // Capture Prolific URL params
    const subject_id = jsPsych.data.getURLVariable('PROLIFIC_PID');
    const study_id   = jsPsych.data.getURLVariable('STUDY_ID');
    const session_id = jsPsych.data.getURLVariable('SESSION_ID');
    jsPsych.data.addProperties({ subject_id, study_id, session_id });

    // ── Build pair list & practice pairs ─────────────────────
    const pool                     = buildStimulusPool();
    const { blocks, allVideoSrcs } = buildTrialList();
    const practicePairs            = buildPracticePairs(pool);

    const practiceSrcs = practicePairs.flatMap(p => [p.first.src, p.second.src]);

    // ── Assemble full timeline ────────────────────────────────
    const timeline = [
        ...buildRefreshRateCheck(),
        ...buildPreExperiment(jsPsych),
        ...buildHeadphoneCheck(),       // headphone screening after consent
        ...buildVolumeAdjust(),
        ...buildPracticeBlock(practicePairs),
        ...buildMainExperiment(blocks),
        ...buildSoundCheck(),
        ...buildDemographicSurvey(),

        // Final debrief
        {
            type    : surveyHtmlForm,
            preamble: '<p>Thank you for participating! Your data is being saved.</p>',
            html    : ' ',
            button_label: 'Finish',
        },
        {
            type    : fullscreen,
            fullscreen_mode: false,
            message : '',
        },
    ];

    // ── Show loading screen while preloading ─────────────────
    const loadingScreen = document.createElement('div');
    loadingScreen.innerHTML = `
        <div style="
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: #fff; display: flex; justify-content: center;
            align-items: center; font-family: sans-serif; z-index: 9999;">
            <p style="font-size: 1.4em;">Loading, please wait…</p>
        </div>`;
    document.body.appendChild(loadingScreen);

    // ── Preload all videos (practice + main), then run ───────
    const srcsToPreload = [...new Set([...practiceSrcs, ...allVideoSrcs])];
    console.log(`Preloading ${srcsToPreload.length} unique video(s)…`);
    await preloadVideos(srcsToPreload);
    console.log('Preload complete — starting experiment.');

    loadingScreen.remove();
    await jsPsych.run(timeline);
}

// Script is loaded at the end of <body>, so DOM is already ready.
runExperiment();