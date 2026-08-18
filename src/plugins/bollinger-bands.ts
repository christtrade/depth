export const bbIndi = `
const bollinger = plugin({
    name: "Bollinger Bands",
    shortName: "BB",
    description: "Standard-deviation envelope around a moving average",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 120,
    params: {
        length: { label: "Length", type: "number", default: 20, min: 2, max: 500 },
        mult:   { label: "Std dev", type: "number", default: 2, min: 0.1, max: 10, step: 0.1 },
        band:   { label: "Bands", type: "color", default: "#08b3de" },
        basis:  { label: "Basis", type: "color", default: "#f5a623" },
        fill:   { label: "Shade channel", type: "boolean", default: true }
    }
})

bollinger.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const { upper, mid, lower } = bb(bars, params.length, params.mult)

    return {
        upper: toPoints(ts, upper),
        mid: toPoints(ts, mid),
        lower: toPoints(ts, lower),
        band: params.band,
        basis: params.basis,
        fill: params.fill
    }
}

bollinger.draw = function(s) {
    const out = []

    if (s.fill) {
        out.push(fillBetween(s.upper, s.lower, { mode: 'solid', color: s.band + '12' }))
    }

    out.push(drawLine(s.upper, s.band, 1))
    out.push(drawLine(s.lower, s.band, 1))
    out.push(drawLine(s.mid, s.basis, 1, [5, 4]))

    return out
}`;
