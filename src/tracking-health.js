// Pure derivation of "tracking health" from heartbeat outcomes + today-progress.
// No Electron/Node deps — unit-testable. Consumed by src/main.js heartbeat loop.

const STALL_STRIKES = 3;           // consecutive flat ok-heartbeats -> stalled (~45-75s)
const FAIL_STRIKES = 2;            // consecutive failed heartbeats -> disconnected (~30-50s)
const PROGRESS_TOLERANCE_SECONDS = 2; // server rounding tolerance

const HEALTH = {
    CONNECTING: 'connecting',   // initial, before first decisive heartbeat
    COUNTING: 'counting',       // time is being credited
    STALLED: 'stalled',         // server reachable but not crediting (off-LAN)
    DISCONNECTED: 'disconnected', // heartbeats failing
};

function initialHealthState() {
    return { health: HEALTH.CONNECTING, windowBaseline: null, stallStrikes: 0, failStrikes: 0 };
}

// prev: a state object. event: { hbOk: boolean, today: number|null }
function deriveHealth(prev, event) {
    const s = { ...prev };

    if (!event.hbOk) {
        s.stallStrikes = 0;
        s.failStrikes = prev.failStrikes + 1;
        if (s.failStrikes >= FAIL_STRIKES) s.health = HEALTH.DISCONNECTED;
        return s;
    }

    // heartbeat ok
    s.failStrikes = 0;
    const today = typeof event.today === 'number' ? event.today : null;

    if (s.windowBaseline == null && today != null) {
        s.windowBaseline = today;
        s.stallStrikes = 0;
        s.health = HEALTH.COUNTING;
        return s;
    }

    if (today != null && s.windowBaseline != null && today - s.windowBaseline > PROGRESS_TOLERANCE_SECONDS) {
        s.windowBaseline = today;
        s.stallStrikes = 0;
        s.health = HEALTH.COUNTING;
        return s;
    }

    // ok but no meaningful growth (or no today value). Note: a server that is
    // reachable but never returns a `today` value goes CONNECTING -> STALLED
    // directly, without ever passing through COUNTING — both are "not counting".
    s.stallStrikes = prev.stallStrikes + 1;
    if (s.stallStrikes >= STALL_STRIKES) s.health = HEALTH.STALLED;
    return s;
}

module.exports = {
    HEALTH, STALL_STRIKES, FAIL_STRIKES, PROGRESS_TOLERANCE_SECONDS,
    initialHealthState, deriveHealth,
};
