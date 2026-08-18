export const supertrendIndi = `
const supertrendIndi = plugin({
    name: "Supertrend",
    shortName: "ST",
    description: "ATR trailing stop that flips with the trend",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 150,
    params: {
        length: { label: "ATR length", type: "number", default: 10, min: 1, max: 200 },
        mult:   { label: "Multiplier", type: "number", default: 3, min: 0.1, max: 20, step: 0.1 },
        up:     { label: "Uptrend", type: "color", default: "#26a69a" },
        down:   { label: "Downtrend", type: "color", default: "#ef5350" },
        markers:{ label: "Flip markers", type: "checkbox", default: true }
    }
})

supertrendIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const { trend, upper, lower } = supertrend(bars, params.length, params.mult)

    // One continuous stop line; colour is per-point so the flip shows in place.
    const pts = []
    const colors = []
    const flips = []

    for (let i = 0; i < bars.length; i++) {
        const up = trend[i] === 1
        const value = up ? lower[i] : upper[i]
        if (isNaN(value)) continue

        pts.push({ t: bars[i].ts, price: value })
        colors.push(up ? params.up : params.down)

        if (i > 0 && trend[i] !== trend[i - 1]) {
            flips.push({ t: bars[i].ts, price: value, up })
        }
    }

    return { pts, colors, flips, up: params.up, down: params.down, markers: params.markers }
}

supertrendIndi.draw = function(s) {
    const out = [drawLine(s.pts, s.colors, 2)]

    if (s.markers) {
        for (const f of s.flips) {
            out.push(drawLabel(f.up ? '▲' : '▼', f.t, f.price, f.up ? s.up : s.down, 11, true, 'center', f.up ? 'top' : 'bottom'))
        }
    }

    return out
}`;
