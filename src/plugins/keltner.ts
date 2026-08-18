export const keltnerIndi = `
const keltnerIndi = plugin({
    name: "Keltner Channels",
    shortName: "KC",
    description: "ATR envelope around an exponential basis",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 150,
    params: {
        length:    { label: "Length", type: "number", default: 20, min: 2, max: 500 },
        atrLength: { label: "ATR length", type: "number", default: 10, min: 1, max: 500 },
        mult:      { label: "Multiplier", type: "number", default: 1.5, min: 0.1, max: 10, step: 0.1 },
        band:      { label: "Channel", type: "color", default: "#26a69a" },
        basis:     { label: "Basis", type: "color", default: "#f5a623" }
    }
})

keltnerIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const { upper, mid, lower } = keltner(bars, params.length, params.atrLength, params.mult)

    return {
        upper: toPoints(ts, upper),
        mid: toPoints(ts, mid),
        lower: toPoints(ts, lower),
        band: params.band,
        basis: params.basis
    }
}

keltnerIndi.draw = function(s) {
    return [
        fillBetween(s.upper, s.lower, { mode: 'solid', color: s.band + '10' }),
        drawLine(s.upper, s.band, 1),
        drawLine(s.lower, s.band, 1),
        drawLine(s.mid, s.basis, 1, [5, 4])
    ]
}`;
