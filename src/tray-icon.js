// Pure renderer for the menu-bar tray clock.
// Returns an RGBA buffer (colored clock) so the face color can signal status.
// Used by both src/main.js (real tray icon) and scripts/preview-tray.js (preview).

function distSeg(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

// Status -> { face: clock-face fill, hand: hands } as [r,g,b].
const STATUS_COLORS = {
    running:   { face: [52, 199, 89],  hand: [255, 255, 255] },  // green  — active/working
    stopped:   { face: [199, 199, 204], hand: [29, 29, 31] },    // gray   — stopped
    launching: { face: [255, 159, 10], hand: [255, 255, 255] },  // orange — starting
    error:     { face: [255, 69, 58],  hand: [255, 255, 255] },  // red    — error
    captcha:   { face: [255, 214, 10], hand: [29, 29, 31] },     // amber  — captcha challenge
    notcounting: { face: [255, 138, 0],  hand: [255, 255, 255] },  // amber  — session active but time NOT being credited
};

// Geometry is expressed as fractions of `size` so the icon scales cleanly.
function renderTrayClock(size, ss, o) {
    o = o || {};
    const C = size / 2;
    const rOuter = o.rOuter != null ? o.rOuter : size * 0.42;       // filled face radius (~2x)
    const hourLen = o.hourLen != null ? o.hourLen : size * 0.215;
    const minLen = o.minLen != null ? o.minLen : size * 0.335;
    const hourHalfW = o.hourHalfW != null ? o.hourHalfW : size * 0.040;
    const minHalfW = o.minHalfW != null ? o.minHalfW : size * 0.030;
    const face = o.face || STATUS_COLORS.running.face;
    const hand = o.hand || STATUS_COLORS.running.hand;

    function tip(angle, len) { return [C + Math.sin(angle) * len, C - Math.cos(angle) * len]; }
    const hTip = tip((10 / 12) * Math.PI * 2, hourLen);
    const mTip = tip((2 / 12) * Math.PI * 2, minLen);

    const inFace = (x, y) => Math.hypot(x - C, y - C) <= rOuter;
    const inHour = (x, y) => distSeg(x, y, C, C, hTip[0], hTip[1]) <= hourHalfW;
    const inMin = (x, y) => distSeg(x, y, C, C, mTip[0], mTip[1]) <= minHalfW;

    function blend(dst, r, g, b, a) {
        if (a <= 0) return;
        const da = dst[3];
        const oa = a + da * (1 - a);
        if (oa <= 0) { dst[3] = 0; return; }
        dst[0] = (r * a + dst[0] * da * (1 - a)) / oa;
        dst[1] = (g * a + dst[1] * da * (1 - a)) / oa;
        dst[2] = (b * a + dst[2] * da * (1 - a)) / oa;
        dst[3] = oa;
    }

    const data = Buffer.alloc(size * size * 4);
    const k = ss * ss;
    for (let oy = 0; oy < size; oy++) {
        for (let ox = 0; ox < size; ox++) {
            let fc = 0, hc = 0, mc = 0;
            for (let sy = 0; sy < ss; sy++) {
                for (let sx = 0; sx < ss; sx++) {
                    const x = ox + (sx + 0.5) / ss, y = oy + (sy + 0.5) / ss;
                    if (inFace(x, y)) fc++;
                    if (inHour(x, y)) hc++;
                    if (inMin(x, y)) mc++;
                }
            }
            const dst = [0, 0, 0, 0];
            blend(dst, face[0], face[1], face[2], fc / k);   // filled face
            blend(dst, hand[0], hand[1], hand[2], hc / k);   // hour hand
            blend(dst, hand[0], hand[1], hand[2], mc / k);   // minute hand
            const o = (oy * size + ox) * 4;
            data[o] = dst[0]; data[o + 1] = dst[1]; data[o + 2] = dst[2]; data[o + 3] = Math.round(dst[3] * 255);
        }
    }
    return { size, data };
}

module.exports = { renderTrayClock, STATUS_COLORS };
