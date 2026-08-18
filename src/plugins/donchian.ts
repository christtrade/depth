export const donchianIndi = `
const donchianIndi = plugin({
    name: "Donchian Channels",
    shortName: "DC",
    description: "Rolling highest high and lowest low",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 100,
    params: {
        length: { label: "Length", type: "number", default: 20, min: 2, max: 500 },
        upper:  { label: "Upper", type: "color", default: "#26a69a" },
        lower:  { label: "Lower", type: "color", default: "#ef5350" },
        showMid:{ label: "Show midline", type: "checkbox", default: true }
    }
})

donchianIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const { upper, mid, lower } = donchian(bars, params.length)

    return {
        upper: toPoints(ts, upper),
        mid: params.showMid ? toPoints(ts, mid) : [],
        lower: toPoints(ts, lower),
        upperColor: params.upper,
        lowerColor: params.lower
    }
}

donchianIndi.draw = function(s) {
    const out = [
        fillBetween(s.upper, s.lower, { mode: 'solid', color: '#ffffff08' }),
        drawLine(s.upper, s.upperColor, 1),
        drawLine(s.lower, s.lowerColor, 1)
    ]

    if (s.mid.length) out.push(drawLine(s.mid, '#787b86', 1, [4, 4]))
    return out
}`;
