// Counted-time accumulator: "Session" reflects only time spent actively counting.
// `now` is injected (Date.now in production) for testability.

function createSessionClock(now) {
    let countedMs = 0;
    let countingSince = null; // timestamp while counting, else null

    return {
        reset() { countedMs = 0; countingSince = null; },
        resume() { if (countingSince == null) countingSince = now(); },
        pause() {
            if (countingSince != null) {
                countedMs += now() - countingSince;
                countingSince = null;
            }
        },
        elapsedMs() {
            return countedMs + (countingSince != null ? now() - countingSince : 0);
        },
        isCounting() { return countingSince != null; },
    };
}

module.exports = { createSessionClock };
