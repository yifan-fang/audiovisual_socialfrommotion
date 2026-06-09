/**
 * ============================================================
 *  SOCIAL PERCEPTION EXPERIMENT  –  Play vs. Fight
 *  Built with jsPsych 7.x
 *
 *  Design:
 *    • 3 sound conditions  : higher / same / lower  (within-participant)
 *    • 7 speed levels      : 1.5 / 2.75 / 4 / 5.25 / 6.5 / 7.75 / 9
 *    • 2 dot colors        : black / grey
 *    • 3 repetitions per   (sound × speed × color) cell
 *    • Extra 2 reps for    speed levels 4, 5.25, 6.5
 *    • ISI counterbalanced across speed levels within each sound condition
 *
 *  Per-trial data logged: trialID, soundCondition, chargeSpeed,
 *    leftColor, repetition, ISI_ms, response, RT, confidenceRating
 *
 *  Data saving: jsPsych.data.get().json() at experiment end.
 *  the on_finish callback of runExperiment() below.
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
// Either inline it below, or add  <script src="trial_metadata.js"></script>
// in index.html (before index.js) with the file exporting a global:
//   var trialMetadata = [ { trialID, chargeSpeed, left_color, repetition, avgCDelay, ISI_ms, ... }, ... ];
//
// Quick inline option for testing — replace with your real data:
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
// Set DEBUG = 1 to run a short 3-trial version for testing.
// Set DEBUG = 0 for the full experiment.
const DEBUG = 1;

// Speed levels and which ones get extra videos
const SPEED_LEVELS      = [1.5, 2.75, 4, 5.25, 6.5, 7.75, 9];
const EXTRA_REPS_SPEEDS = new Set([4, 5.25, 6.5]);  // get 2 more reps each
const BASE_REPS         = 3;
const EXTRA_REPS        = 2;

const SOUND_CONDITIONS  = ['higher', 'same', 'lower'];
const COLORS            = ['black', 'grey'];

// Video base path — relative to index.html location
const VIDEO_BASE_PATH   = './videos';

// Number of blocks
const N_BLOCKS          = DEBUG ? 1 : 6;   



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

/** Deep-copy-shuffle: returns a shuffled copy without mutating the original. */
function shuffled(arr) { return shuffle([...arr]); }

/** Build the video file path from a sound condition and trialID. */
function videoPath(soundCondition, trialID) {
    return `${VIDEO_BASE_PATH}/${soundCondition}/${trialID}.mp4`;
}

/**
 * Compute the ISI percentile rank of a value within an array.
 * Used for ISI-matching across sound conditions.
 */
function percentileRank(value, sortedArray) {
    let lo = 0, hi = sortedArray.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sortedArray[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo / sortedArray.length;
}



// ════════════════════════════════════════════════════════════
//  3.  TRIAL SAMPLING WITH ISI COUNTERBALANCING
// ════════════════════════════════════════════════════════════

/**
 * loadTrialMetadata()
 * -------------------
 * Parses trialMetadata (imported from trial_metadata.js) and groups rows by
 * (chargeSpeed × left_color) so we can sample from them.
 *
 * Returns: Map<key, row[]>  where key = `${chargeSpeed}_${left_color}`
 */
function loadTrialMetadata() {
    const pool = new Map();
    for (const row of trialMetadata) {
        // Skip incomplete trials (missing second touch time = no valid video)
        if (row.touch_time_2_s === null || row.touch_time_2_s === undefined) {
            console.warn(`Skipping incomplete trial: ${row.trialID}`);
            continue;
        }
        const key = `${row.chargeSpeed}_${row.left_color}`;
        if (!pool.has(key)) pool.set(key, []);
        pool.get(key).push({ ...row }); // shallow copy so we can splice safely
    }
    return pool;
}

/**
 * sampleTrialsForCondition(pool, soundCondition, targetISIPercentiles)
 * -----------------------------------------------------------------------
 * For a single sound condition, samples the required number of trials per
 * (speed × color) cell while matching the ISI percentile distribution to
 * `targetISIPercentiles` (an array of percentile values, one per trial slot).
 *
 * When `targetISIPercentiles` is null (first condition sampled), it records
 * the ISI percentiles of whatever it picks as the reference distribution.
 *
 * Returns: { trials: TrialRow[], isiPercentiles: number[] }
 */
function sampleTrialsForCondition(pool, soundCondition, targetISIPercentiles) {
    const result = [];

    for (const speed of SPEED_LEVELS) {
        const nReps = BASE_REPS + (EXTRA_REPS_SPEEDS.has(speed) ? EXTRA_REPS : 0);

        for (const color of COLORS) {
            const key         = `${speed}_${color}`;
            const candidates  = pool.get(key);
            if (!candidates || candidates.length === 0) {
                console.warn(`No candidates for ${key} — skipping`);
                continue;
            }

            // Sort candidates by ISI ascending for percentile matching
            const sorted = [...candidates].sort((a, b) => a.ISI_ms - b.ISI_ms);
            const chosen = [];

            for (let r = 0; r < nReps; r++) {
                let pick;
                if (targetISIPercentiles) {
                    // Pick the candidate whose ISI best matches the target percentile
                    const targetPct   = targetISIPercentiles[result.length + r] ?? 0.5;
                    const targetISI   = sorted[Math.round(targetPct * (sorted.length - 1))]?.ISI_ms;
                    const remaining   = candidates.filter(c => !chosen.includes(c));
                    pick = remaining.reduce((best, c) =>
                        Math.abs(c.ISI_ms - targetISI) < Math.abs(best.ISI_ms - targetISI) ? c : best
                    );
                } else {
                    // First condition: random selection
                    const remaining = candidates.filter(c => !chosen.includes(c));
                    pick = remaining[Math.floor(Math.random() * remaining.length)];
                }
                chosen.push(pick);
                result.push({ ...pick, soundCondition, videoSrc: videoPath(soundCondition, pick.trialID) });
            }
        }
    }

    // Compute ISI percentile for each selected trial (reference for next condition)
    const allISIs      = result.map(t => t.ISI_ms).sort((a, b) => a - b);
    const isiPctiles   = result.map(t => percentileRank(t.ISI_ms, allISIs));

    return { trials: result, isiPercentiles: isiPctiles };
}

/**
 * buildTrialList()
 * ----------------
 * Samples all trials across all three sound conditions with ISI balancing,
 * then divides them into N_BLOCKS interleaved blocks.
 *
 * Block order is randomised; within each block, trials are shuffled.
 *
 * Returns: { blocks: Trial[][], allVideoSrcs: string[] }
 */
function buildTrialList() {
    // Each sound condition gets its own independent pool
    const conditionOrder = shuffled(SOUND_CONDITIONS);
    let refPercentiles   = null;
    const trialsByCondition = [];

    for (const condition of conditionOrder) {
        const pool = loadTrialMetadata();
        const { trials, isiPercentiles } = sampleTrialsForCondition(pool, condition, refPercentiles);
        if (!refPercentiles) refPercentiles = isiPercentiles;
        trialsByCondition.push(shuffle(trials)); // shuffle within each condition
    }

    // In debug mode: 1 trial per condition (3 total), 1 block, skip preloading wait
    if (DEBUG) {
        const debugTrials = trialsByCondition.map(t => t.slice(0, 1)).flat();
        shuffle(debugTrials);
        console.warn(`DEBUG MODE: running ${debugTrials.length} trials only.`);
        return { blocks: [debugTrials], allVideoSrcs: debugTrials.map(t => t.videoSrc) };
    }

    // Interleave conditions into blocks so every block has a mix of all three.
    // Strategy: split each condition's trials into N_BLOCKS chunks, then
    // combine one chunk from each condition per block and shuffle within.
    const blocks = Array.from({ length: N_BLOCKS }, () => []);
    for (const condTrials of trialsByCondition) {
        const chunkSize = Math.ceil(condTrials.length / N_BLOCKS);
        for (let b = 0; b < N_BLOCKS; b++) {
            const chunk = condTrials.slice(b * chunkSize, (b + 1) * chunkSize);
            blocks[b].push(...chunk);
        }
    }

    // Shuffle within each block so conditions are intermixed
    blocks.forEach(b => shuffle(b));

    // Shuffle block order
    shuffle(blocks);

    const allTrials    = blocks.flat();
    const allVideoSrcs = allTrials.map(t => t.videoSrc);
    return { blocks, allVideoSrcs };
}



// ════════════════════════════════════════════════════════════
//  4.  VIDEO PRELOADING
// ════════════════════════════════════════════════════════════

/**
 * preloadVideos(videoSrcList)
 * ---------------------------
 * Injects hidden <video> elements and resolves when all have buffered.
 *
 * ⚠️  BROWSER NOTE: Chrome and Safari may block autoplay (even muted) in some
 *     contexts. Muted + autoplay is generally permitted, which covers all
 *     video playback here. Test on Chrome, Firefox, and Safari before launch.
 */
function preloadVideos(videoSrcList) {
    const uniqueSrcs = [...new Set(videoSrcList)];
    const BATCH_SIZE = 10; // load 10 at a time to avoid Chrome throttling

    // Load one batch, resolve when all in batch are ready
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

    // Process batches sequentially
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
//  5.  JSPSYCH TRIAL BUILDERS
// ════════════════════════════════════════════════════════════

/**
 * buildHeadphoneCheck()
 * ---------------------
 * Wraps the McDermott HeadphoneCheck library in a jsPsych trial.
 * The trial holds until the check completes, then either continues
 * or ends the experiment if the participant fails.
 *
 * ⚠️  BROWSER NOTE: Audio requires a user gesture before playing in
 *     Chrome/Safari. The jsPsych "click to continue" button before this
 *     trial satisfies that requirement — don't skip it.
 */
function buildHeadphoneCheck(jsPsych) {
    return {
        type: htmlKeyboardResponse,
        stimulus: `
            <div id="hc-container"></div>
            <p style="margin-top:20px; color:#666; font-size:0.9em;">
                Complete the sound check above to continue.
            </p>`,
        choices: 'NO_KEYS',           // jsPsych won't advance — HeadphoneCheck drives it
        response_ends_trial: false,
        data: { task: 'headphone_check' },
        on_load: function () {
            // Must initialise inside on_load so #hc-container exists in the DOM
            $(document).off('hcHeadphoneCheckEnd'); // remove any stale listener

            $(document).on('hcHeadphoneCheckEnd', function (event, data) {
                // Log result into jsPsych data
                jsPsych.data.addProperties({
                    headphone_check_passed: data.didPass,
                    headphone_check_score : data.data.totalCorrect,
                });

                if (data.didPass) {
                    jsPsych.finishTrial({ headphone_check_passed: true });
                } else {
                    // Participant failed — end experiment early
                    jsPsych.endExperiment(
                        '<p>Unfortunately you did not pass the headphone check ' +
                        '(you need at least 5/6 correct).</p>' +
                        '<p>Please return this study on Prolific.</p>'
                    );
                }
            });

            HeadphoneCheck.runHeadphoneCheck({ doCalibration: true });
        },
        on_finish: function () {
            $(document).off('hcHeadphoneCheckEnd'); // clean up listener
        },
    };
}

/**
 * buildVideoTrial(trialInfo)
 * --------------------------
 * Returns a jsPsych trial that plays one video (with audio for sound condition).
 * Video is 15 s maximum; no keyboard response allowed during playback.
 */
function buildVideoTrial(trialInfo) {
    return {
        type                  : htmlKeyboardResponse,
        stimulus              : '<div id="videoContainer"></div>',
        choices               : 'NO_KEYS',
        response_ends_trial   : false,
        trial_duration        : null,  // no timeout — trial ends when video finishes
        data: {
            task           : 'video_playback',
            trialID        : trialInfo.trialID,
            soundCondition : trialInfo.soundCondition,
            chargeSpeed    : trialInfo.chargeSpeed,
            leftColor      : trialInfo.left_color,
            repetition     : trialInfo.repetition,
            ISI_ms         : trialInfo.ISI_ms,
            videoSrc       : trialInfo.videoSrc,
        },
        on_load: function () {
            const container = document.getElementById('videoContainer');
            container.innerHTML = '';

            const vid       = document.createElement('video');
            vid.src         = trialInfo.videoSrc;
            vid.controls    = false;
            vid.autoplay    = true;
            vid.muted       = false;
            vid.height      = 600;
            vid.width       = 800;
            container.appendChild(vid);

            // End trial when video finishes
            vid.addEventListener('ended', () => jsPsych.finishTrial());
            vid.play().catch(err => console.warn('Video play() rejected:', err));
        },
        on_finish: function (data) {
            // Re-show the cursor (hidden during playback) so the participant can
            // use the mouse for the upcoming play/fight click and confidence slider.
            document.body.style.cursor = 'auto';
            // Trial data logged automatically by jsPsych.
        },
    };
}

/**
 * buildResponseTrial(labelLeft, labelRight)
 * -----------------------------------------
 * Binary forced-choice via MOUSE: participant clicks either the left or right
 * button. The left/right label order is randomised per session (passed in via
 * randomiseResponseMapping) to counterbalance side bias.
 *
 * jsPsych's html-button-response logs `response` as the index of the clicked
 * button (0 = left button, 1 = right button) and `rt` automatically.
 */
function buildResponseTrial(labelLeft, labelRight) {
    return {
        type                : htmlButtonResponse,
        stimulus            : `
            <p>Did the interaction look like <strong>playing</strong> or <strong>fighting</strong>?</p>
            <p>Click your choice below.</p>`,
        // Buttons render left-to-right in this array order.
        choices             : [labelLeft, labelRight],
        response_ends_trial : true,
        trial_duration      : null,  // wait indefinitely for a click
        data: {
            task         : 'play_fight_response',
            label_left   : labelLeft,
            label_right  : labelRight,
        },
        on_finish: function (data) {
            // data.response is the clicked button index (0 = left, 1 = right).
            // Recode to the semantic label and a clean is_fight flag for analysis.
            const clicked       = data.response === 0 ? labelLeft : labelRight;
            data.response_label = clicked;            // 'Playing' or 'Fighting'
            data.is_fight       = clicked === 'Fighting';
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
 * slider at least once — this prevents a default/un-set rating being logged.
 *
 * Final value is logged as `confidence_rating` (0–100).
 *
 * ⚠️  We use html-button-response with a single "Confirm" button and drive the
 *     slider through our own pointer listeners, so jsPsych doesn't interfere
 *     with the drag interaction. Document-level listeners are removed on finish
 *     to prevent leakage into subsequent trials.
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
        // Render Confirm disabled; we enable it on the participant's first slider interaction.
        button_html         : '<button class="jspsych-btn" disabled id="conf-confirm-btn">%choice%</button>',
        response_ends_trial : true,
        trial_duration      : null,  // wait indefinitely until participant confirms
        data                : { task: 'confidence_rating' },
        on_load: function () {
            let position = 50;       // 0–100; not yet "set" by the participant
            let hasMoved = false;
            let dragging = false;

            const handle  = document.getElementById('conf-handle');
            const track   = document.getElementById('conf-track');
            const warning = document.getElementById('conf-warning');
            const confirm = document.getElementById('conf-confirm-btn');

            // Convert a pointer x-coordinate into a 0–100 position along the track.
            function positionFromEvent(e) {
                const rect = track.getBoundingClientRect();
                const x    = e.clientX - rect.left;
                // Clamp to [0, trackWidth], then scale to 0–100.
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

            // Click anywhere on the track jumps the handle there and starts a drag.
            track.addEventListener('pointerdown', (e) => {
                dragging = true;
                applyPosition(positionFromEvent(e));
            });

            // Dragging updates continuously while the button is held. We listen on
            // document so the drag still works if the pointer strays off the track.
            this._confMoveHandler = (e) => {
                if (!dragging) return;
                applyPosition(positionFromEvent(e));
            };
            this._confUpHandler = () => { dragging = false; };

            document.addEventListener('pointermove', this._confMoveHandler);
            document.addEventListener('pointerup',   this._confUpHandler);

            // Expose the current value so on_finish can read it.
            this._getConfidence = () => position;
        },
        on_finish: function (data) {
            // Record the final slider value.
            data.confidence_rating = this._getConfidence ? this._getConfidence() : null;

            // Clean up document-level listeners so they don't leak into later trials.
            if (this._confMoveHandler) document.removeEventListener('pointermove', this._confMoveHandler);
            if (this._confUpHandler)   document.removeEventListener('pointerup',   this._confUpHandler);
            this._confMoveHandler = null;
            this._confUpHandler   = null;
            this._getConfidence   = null;
        },
    };
}

/** Short blank-screen inter-trial interval (100 ms). Gives a brief visual gap
 *  between trials so successive screens don't flash directly into each other. */
function buildITI() {
    return {
        type                : htmlKeyboardResponse,
        stimulus            : ' ',
        trial_duration      : 100,
        response_ends_trial : false,
        choices             : 'NO_KEYS',   // no input accepted during the blank gap
        // No keyboard-buffer cleanup needed anymore — responses are mouse-driven.
        // The single trial_duration timeout fires and clears itself.
    };
}



// ════════════════════════════════════════════════════════════
//  6.  RESPONSE LABEL RANDOMISATION
// ════════════════════════════════════════════════════════════

/**
 * Randomly assign Playing/Fighting to the LEFT/RIGHT button positions to
 * counterbalance side bias. Returns { labelLeft, labelRight }.
 */
function randomiseResponseMapping() {
    if (Math.random() < 0.5) {
        return { labelLeft: 'Playing', labelRight: 'Fighting' };
    }
    return { labelLeft: 'Fighting', labelRight: 'Playing' };
}



// ════════════════════════════════════════════════════════════
//  7.  PRACTICE TRIALS
// ════════════════════════════════════════════════════════════

/**
 * buildPracticeBlock(mapping)
 * ----------------------------
 * Two practice trials using the 'same' sound condition (no audio manipulation).
 * One clearly-playing video (low speed) and one clearly-fighting video (high speed).
 */
function buildPracticeBlock(mapping) {
    const { labelLeft, labelRight } = mapping;

    // Select two practice videos: one from speed 1.5 (playing-like) and one from 9 (fighting-like)
    const pracLow  = trialMetadata.find(t => t.chargeSpeed === 1.5);
    const pracHigh = trialMetadata.find(t => t.chargeSpeed === 9);

    if (!pracLow || !pracHigh) {
        console.warn('Practice trial metadata not found — check trialMetadata import.');
    }

    const pracLowInfo  = { ...pracLow,  soundCondition: 'same', videoSrc: videoPath('same', pracLow?.trialID  ?? '') };
    const pracHighInfo = { ...pracHigh, soundCondition: 'same', videoSrc: videoPath('same', pracHigh?.trialID ?? '') };

    const respTrial  = buildResponseTrial(labelLeft, labelRight);
    const confTrial  = buildConfidenceTrial();

    return [
        // Instruction for practice
        {
            type              : surveyHtmlForm,
            preamble: `
                <h2>Practice Trials</h2>
                <p>You will now watch two short practice videos to get familiar with the task.</p>
                <p>After each video, you will be asked:</p>
                <ul style="text-align:left; display:inline-block;">
                    <li>Whether the depicted interaction appeared to be <strong>playing</strong> or <strong>fighting</strong></li>
                    <li>How <strong>confident</strong> you are in your answer</li>
                </ul>
                <p>After each video, click <b>${labelLeft}</b> or <b>${labelRight}</b>,
                   then set the confidence slider with your mouse and press Confirm.</p>`,
            html              : ' ',
            button_label      : 'Begin Practice',
            response_ends_trial: true,
        },
        // Practice trial 1 (low speed)
        { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'none'; } },
        { ...buildVideoTrial(pracLowInfo), data: { ...buildVideoTrial(pracLowInfo).data, isPractice: true } },
        buildITI(),
        { ...respTrial, data: { ...respTrial.data, isPractice: true } },
        buildITI(),
        { ...confTrial, data: { ...confTrial.data, isPractice: true } },
        buildITI(),
        // Practice trial 2 (high speed)
        { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'none'; } },
        { ...buildVideoTrial(pracHighInfo), data: { ...buildVideoTrial(pracHighInfo).data, isPractice: true } },
        buildITI(),
        { ...respTrial, data: { ...respTrial.data, isPractice: true } },
        buildITI(),
        { ...confTrial, data: { ...confTrial.data, isPractice: true } },
        buildITI(),
        // Restore cursor after practice
        { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'auto'; } },
    ];
}



// ════════════════════════════════════════════════════════════
//  8.  MAIN EXPERIMENT BLOCK BUILDER
// ════════════════════════════════════════════════════════════

/**
 * buildMainExperiment(blocks, mapping)
 * -------------------------------------
 * Generates the main timeline from pre-sampled trial blocks.
 * Each block starts with a brief reminder of the key mapping.
 */
function buildMainExperiment(blocks, mapping) {
    const { labelLeft, labelRight } = mapping;
    const respTrial  = buildResponseTrial(labelLeft, labelRight);
    const confTrial  = buildConfidenceTrial();
    const trials     = [];

    for (let b = 0; b < blocks.length; b++) {
        // Block start instruction
        trials.push({
            type              : surveyHtmlForm,
            preamble: `
                <p><strong>Block ${b + 1} of ${blocks.length}</strong></p>
                <p>Watch each video and decide: <strong>playing</strong> or
                <strong>fighting</strong>?</p>
                <p>Click <b>${labelLeft}</b> or <b>${labelRight}</b> after each video,
                   then rate your confidence with the slider.</p>`,
            html              : ' ',
            button_label      : b === 0 ? 'Begin Experiment' : 'Continue',
            response_ends_trial: true,
        });

        for (const trialInfo of blocks[b]) {
            // Stamp the video's identifying metadata onto the response and
            // confidence rows too, so every row carries the trial identity.
            // (Without this, only the video_playback row knows trialID/speed/etc.,
            // which is why those columns were blank on the response/confidence rows.)
            const trialMeta = {
                trialID        : trialInfo.trialID,
                soundCondition : trialInfo.soundCondition,
                chargeSpeed    : trialInfo.chargeSpeed,
                leftColor      : trialInfo.left_color,
            };

            trials.push(
                { type: CallFunctionPlugin, func: () => { document.body.style.cursor = 'none'; } },
                buildVideoTrial(trialInfo),
                buildITI(),
                // shallow copy so each instance is independent; merge trial metadata
                // into its data object so the response row is self-identifying.
                { ...respTrial, data: { ...respTrial.data, ...trialMeta } },
                buildITI(),
                { ...confTrial, data: { ...confTrial.data, ...trialMeta } },
                buildITI(),
            );
        }

        // Optional mid-block rest screen (after every block except the last)
        if (b < blocks.length - 1) {
            trials.push({
                type              : surveyHtmlForm,
                preamble          : '<p>Feel free to take a short break. Press "Continue" when ready.</p>',
                html              : ' ',
                button_label      : 'Continue',
                response_ends_trial: true,
                on_load: function () {
                    document.body.style.cursor = 'auto';
                },
            });
        }
    }

    return trials;
}



// ════════════════════════════════════════════════════════════
//  9.  DEMOGRAPHIC SURVEY
// ════════════════════════════════════════════════════════════

function buildDemographicSurvey() {
    return [
        {
            type  : surveyHtmlForm,
            preamble: '<p>Thank you for completing the experiment! Please answer a few brief demographic questions.</p>',
            html  : ' ',
            button_label: 'Continue',
            response_ends_trial: true,
        },
        {
            type : surveyMultiChoice,
            // task:'demographic' lets saveAndReturn() collect every demographic
            // answer with one filter instead of digging through rawData.
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
    ];
}

/**
 * buildDemographics()
 * -------------------
 * Flattens all task:'demographic' survey responses into a single object,
 * e.g. { gender, hispanic, race, age, location, strategy, feedback }.
 * surveyMultiSelect returns arrays (e.g. race) — joined with '; ' for a flat cell.
 * Called by saveAndReturn() so the saved file carries one tidy demographics
 * object instead of several scattered survey rows.
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
 * Uses a custom htmlKeyboardResponse trial that renders the hc-container
 * div, runs the check, and finishes the trial when the check completes.
 *
 * Participants who fail are shown a warning and the experiment ends.
 * Requires jQuery and HeadphoneCheck.min.js loaded in index.html.
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
            // Listen for the headphone check to complete
            $(document).on('hcHeadphoneCheckEnd', function (event, data) {
                $(document).off('hcHeadphoneCheckEnd'); // remove listener
                jsPsych.finishTrial({
                    hc_passed      : data.didPass,
                    hc_totalCorrect: data.data.totalCorrect,
                    hc_numTrials   : data.data.stimIDList.length,
                });
            });
            // Start the headphone check (6 trials, must get 5/6 correct)
            HeadphoneCheck.runHeadphoneCheck({ doCalibration: false });
        },
    };

    // If participant failed, show a message and end the experiment
    const failTrial = {
        type          : htmlKeyboardResponse,
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
//  11.  PROLIFIC & CONSENT
// ════════════════════════════════════════════════════════════

function buildPreExperiment(jsPsych) {
    return [
        // Prolific ID — only ask manually if it wasn't captured from the URL.
        // On a normal Prolific launch the ID arrives as ?PROLIFIC_PID=... and is
        // already stored via addProperties() in runExperiment(), so this step is
        // skipped. The conditional_function checks the stored value at run time.
        {
            timeline: [
                {
                    type    : surveyHtmlForm,
                    preamble: '<p>Please enter your <strong>Prolific ID</strong> to begin.</p>',
                    html    : '<input id="prolific_id" type="text" name="prolific_id" size="40" required>',
                    on_finish: function (data) {
                        // Use the typed ID as the subject_id so downstream saving
                        // (which reads subject_id) works in the no-URL fallback case.
                        const typed = data.response?.prolific_id;
                        if (typed) jsPsych.data.addProperties({ subject_id: typed });
                    },
                },
            ],
            conditional_function: function () {
                // Run this form only if no ID was captured from the URL.
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
        // ── Experiment instructions / cover story ──────────────────────────────
        {
            type         : surveyHtmlForm,
            preamble: `
                <h2>Experiment Instructions</h2>
                <p style="text-align:left;">We recently videotaped a public park where nearby children go and 
                recorded the sounds as they interacted, with the goal of capturing the essence of children's 
                behaviors within a familiar park setting. To protect the identities of these young people, we 
                used an algorithm that represents a pair of children as two dots, each tracing the path of an 
                individual child, and replaced actual voices with a scrambled noise signal. </p>

                <p style="text-align:left;">In this study, you will watch the videos and make judgments
                 about the social interactions depicted. After each video, click on "play" or "fight" to 
                 indicate your judgment. Then, indicate how confident you are in your judgment using 
                 the slider.</p>`,
            html         : ' ',
            button_label : 'Continue',
            response_ends_trial: true,
        },
        // Device / environment
        {
            type         : surveyHtmlForm,
            preamble     : '<p>Please turn off any music, podcasts, or other audio before continuing.</p>',
            html         : ' ',
            button_label : 'Done — Continue',
            response_ends_trial: true,
        },
        // ── Audio unlock ──────────────────────────────────────────────────────
        // Browsers require a user gesture before allowing audio playback.
        // This page's button click acts as that gesture, unlocking audio for
        // all subsequent video trials in the session.
        {
            type    : surveyHtmlForm,
            preamble: `
                <h2>Audio Setup</h2>\
                <p>Please make sure your <strong>volume is turned up</strong> and
                you are wearing <strong>headphones</strong> if possible.</p>
                <p>Click the button below continue.</p>`,
            html    : ' ',
            button_label: 'Continue',
            response_ends_trial: true,
            on_finish: function () {
                // Play a silent buffer through AudioContext to unlock audio autoplay
                try {
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    const buf = ctx.createBuffer(1, 1, 22050);
                    const src = ctx.createBufferSource();
                    src.buffer = buf;
                    src.connect(ctx.destination);
                    src.start(0);
                } catch(e) {
                    console.warn('AudioContext unlock failed:', e);
                }
            },
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
        type          : htmlKeyboardResponse,
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
//  12b.  TIDY TRIAL TABLE (one row per played video)
// ════════════════════════════════════════════════════════════

/**
 * buildTidyTrials()
 * -----------------
 * Walks the raw jsPsych data in presentation order and consolidates each
 * experimental trial — which spans THREE jsPsych rows (video_playback →
 * play_fight_response → confidence_rating) — into a SINGLE tidy row.
 *
 * One row is emitted per played video. `trial_number` increments only when a
 * video has played (practice trials are excluded). `id` is the participant's
 * Prolific PID, identical on every row.
 *
 * Output columns:
 *   id, trial_number, trialID, soundCondition, chargeSpeed, leftColor,
 *   response, response_rt, confidence, confidence_rt
 *
 * Assumes the canonical per-trial order video → response → confidence, which is
 * how buildMainExperiment() assembles the timeline. We anchor on each
 * video_playback row and read forward to the next response and confidence rows,
 * so intervening ITI rows don't matter.
 *
 * Returns: Array<Object> — one object per trial.
 */
function buildTidyTrials() {
    const all = jsPsych.data.get().values();

    // Participant ID is added via addProperties, so it's on every row; grab the
    // first non-empty one as a fallback.
    const participantId =
        all.find(r => r.subject_id)?.subject_id ?? null;

    const tidy = [];
    let trialNumber = 0;

    for (let i = 0; i < all.length; i++) {
        const row = all[i];
        if (row.task !== 'video_playback') continue;
        if (row.isPractice) continue;  // skip practice videos

        // Read forward from this video row to find its response and confidence
        // rows (the next ones of each task type before the next video).
        let responseRow   = null;
        let confidenceRow = null;
        for (let j = i + 1; j < all.length; j++) {
            const next = all[j];
            if (next.task === 'video_playback') break;  // reached the next trial
            if (next.task === 'play_fight_response' && !responseRow)   responseRow   = next;
            if (next.task === 'confidence_rating'   && !confidenceRow) confidenceRow = next;
            if (responseRow && confidenceRow) break;
        }

        trialNumber += 1;

        tidy.push({
            id             : participantId,
            trial_number   : trialNumber,
            // Identifiers come off the video row (always present there).
            trialID        : row.trialID        ?? null,
            soundCondition : row.soundCondition ?? null,
            chargeSpeed    : row.chargeSpeed     ?? null,
            leftColor      : row.leftColor       ?? null,
            // ISI and repetition also come off the video row — needed as
            // analysis covariates (ISI counterbalancing) but otherwise only
            // present in the raw video rows, forcing a separate merge.
            ISI_ms         : row.ISI_ms         ?? null,
            repetition     : row.repetition      ?? null,
            // Binary choice, normalised to lowercase 'play' / 'fight'.
            response       : responseRow
                ? (responseRow.is_fight ? 'fight' : 'play')
                : null,
            is_fight       : responseRow ? (responseRow.is_fight ? 1 : 0) : null,
            response_rt    : responseRow?.rt ?? null,        // ms, from button click
            // Confidence rating (slider value) and its own RT.
            confidence     : confidenceRow?.confidence_rating ?? null,
            confidence_rt  : confidenceRow?.rt ?? null,      // ms, time to confirm
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
        'id', 'trial_number', 'trialID', 'soundCondition',
        'chargeSpeed', 'leftColor', 'ISI_ms', 'repetition',
        'response', 'is_fight', 'response_rt',
        'confidence', 'confidence_rt',
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
 * saveAndReturn(startTime)
 * ------------------------
 * Collects all relevant trial and session data, POSTs it to the
 * Dartmouth lab server, then redirects to Prolific on success.
 *
 * Mirrors the SaveAndReturn / ReturnToSona pattern from other lab experiments.
 * ⚠️  Update experimentName and the Prolific completion code before each study.
 */
function saveAndReturn(startExperimentTime) {
    const endTime   = new Date();
    const totalTime = endTime - startExperimentTime;

    // ── The two analysis-ready tables ─────────────────────────
    // trials:       one row per real (non-practice) trial, every analysis column
    //               already present (see buildTidyTrials). -> pd.DataFrame(curData.trials)
    // demographics: one flat object of survey answers (see buildDemographics).
    //               -> pd.DataFrame([curData.demographics])
    const trials       = buildTidyTrials();
    const demographics = buildDemographics();

    // Headphone check result
    const hcData       = jsPsych.data.get().filter({ task: 'headphone_check' }).values()[0];

    // Refresh rate (logged once during the refresh-rate check)
    const refreshRate  = jsPsych.data.get().values()
                           .find(d => d.refresh_rate_hz)?.refresh_rate_hz ?? null;

    // Prolific / session IDs (added at experiment start)
    const subject_id   = jsPsych.data.get().values()[0]?.subject_id ?? null;
    const study_id     = jsPsych.data.get().values()[0]?.study_id   ?? null;
    const session_id   = jsPsych.data.get().values()[0]?.session_id ?? null;

    // Fold session/participant metadata INTO the demographics object so the
    // demographic DataFrame is self-contained (one row, everything about the
    // participant). subject_id is the key to join trials <-> demographics.
    Object.assign(demographics, {
        subject_id, study_id, session_id,
        institution     : 'Prolific',
        begTime         : startExperimentTime,
        endTime,
        totalTime,
        experimentName  : 'audio_visual_socialperception',  // ⚠️ update per study
        debug           : DEBUG,
        nBlocks         : N_BLOCKS,
        windowWidth     : window.innerWidth,
        windowHeight    : window.innerHeight,
        screenWidth     : screen.width,
        screenHeight    : screen.height,
        refreshRate,
        hc_passed       : hcData?.hc_passed       ?? null,
        hc_totalCorrect : hcData?.hc_totalCorrect ?? null,
        hc_numTrials    : hcData?.hc_numTrials     ?? null,
    });

    // Stamp subject_id onto every trial row so the two tables join cleanly.
    trials.forEach(t => { t.subject_id = subject_id; });

    const curData = {
        // Two clean tables — this is all the analysis needs.
        trials,         // pd.DataFrame(curData.trials)
        demographics,   // pd.DataFrame([curData.demographics])

        // Raw jsPsych dump kept ONLY in debug, for troubleshooting. In a live
        // run we omit it to keep the saved file small and unambiguous.
        ...(DEBUG ? { rawData: jsPsych.data.get().values() } : {}),
    };

    const dataToServer = {
        id             : subject_id ?? ('anon_' + Date.now()),
        experimenter   : 'YF',
        experimentName : DEBUG
                           ? 'audiovisual_socialfrommotion_DEBUG'   // ⚠️ separate name for debug
                           : 'audiovisual_socialfrommotion_pilot',  // ⚠️ update experimentName per study
        curData        : JSON.stringify(curData),
    };

    // POST to lab server, then redirect to Prolific on success
    $.post(
        'https://rcweb.dartmouth.edu/StoermerLab/save.php',
        dataToServer,
        function () {
            // ⚠️ Update the Prolific completion code for each new study
            window.location.href = 'https://app.prolific.com/submissions/complete?cc=XXXXXXXX';
        }
    ).fail(function () {
        // If save fails, log and still redirect so participant gets credit
        console.error('Data save failed — redirecting anyway.');
        window.location.href = 'https://app.prolific.com/submissions/complete?cc=XXXXXXXX';
    });
}



// ════════════════════════════════════════════════════════════
//  14.  MAIN ENTRY POINT
// ════════════════════════════════════════════════════════════

async function runExperiment() {

    const startExperimentTime = new Date();

    // ── Initialise jsPsych ────────────────────────────────────
    // Assigns to the module-level jsPsych variable so all builder functions can use it.
    jsPsych = initJsPsych({
        override_safe_mode : true,
        show_progress_bar  : true,
        on_finish: function () {
            if (DEBUG) {
                // Save the TIDY table (one row per played video) rather than the
                // raw jsPsych dump, so the debug file already has the analysis
                // columns: id, trial_number, trialID, soundCondition, chargeSpeed,
                // leftColor, response, response_rt, confidence, confidence_rt.
                const csv  = tidyTrialsToCSV(buildTidyTrials());
                const blob = new Blob([csv], { type: 'text/csv' });
                const a    = document.createElement('a');
                a.href     = URL.createObjectURL(blob);
                a.download = 'debug_data_tidy.csv';
                a.click();
                URL.revokeObjectURL(a.href);
                console.log('DEBUG: tidy data saved to debug_data_tidy.csv');
                saveAndReturn(startExperimentTime);
            } else {
                saveAndReturn(startExperimentTime);
            }
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

    // ── Build trial list & response mapping ──────────────────
    const { blocks, allVideoSrcs } = buildTrialList();
    const mapping                  = randomiseResponseMapping();

    // ── Assemble full timeline ────────────────────────────────
    const timeline = [
        ...buildRefreshRateCheck(jsPsych),
        ...buildPreExperiment(jsPsych),
        ...buildHeadphoneCheck(),       // headphone screening after consent
        ...buildPracticeBlock(mapping),
        ...buildMainExperiment(blocks, mapping),
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

    // ── Preload all videos, then run ──────────────────────────
    console.log(`Preloading ${allVideoSrcs.length} video(s)…`);
    await preloadVideos(allVideoSrcs);
    console.log('Preload complete — starting experiment.');

    loadingScreen.remove();
    await jsPsych.run(timeline);
}

// Script is loaded at the end of <body>, so DOM is already ready.
runExperiment();