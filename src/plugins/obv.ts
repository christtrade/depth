export const obvIndi = `
const obvIndi = plugin({
    name: "On-Balance Volume",
    shortName: "OBV",
    description: "Running volume signed by the close",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 200,
    params: {
        smoothing: { label: "Average", type: "number", default: 20, min: 0, max: 500 },
        line: { label: "OBV", type: "color", default: "#08b3de" },
        avg:  { label: "Average", type: "color", default: "#f5a623" }
    }
})

obvIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const values = obv(bars)

    return {
        obv: toPoints(ts, values),
        avg: params.smoothing >= 2 ? toPoints(ts, ema(values, params.smoothing)) : [],
        line: params.line,
        avgColor: params.avg
    }
}

obvIndi.draw = function(s) {
    const out = [drawLine(s.obv, s.line, 2)]
    if (s.avg.length) out.push(drawLine(s.avg, s.avgColor, 1))
    return out
}`;
