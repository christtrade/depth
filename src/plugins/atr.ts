export const atrIndi = `
const atrIndi = plugin({
    name: "Average True Range",
    shortName: "ATR",
    description: "Wilder-smoothed range, in price units",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 150,
    params: {
        length: { label: "Length", type: "number", default: 14, min: 1, max: 300 },
        smoothing: { label: "Average", type: "number", default: 0, min: 0, max: 300 },
        line:   { label: "ATR", type: "color", default: "#f5a623" },
        avg:    { label: "Average", type: "color", default: "#787b86" }
    }
})

atrIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const values = atr(bars, params.length)

    return {
        atr: toPoints(ts, values),
        avg: params.smoothing >= 2 ? toPoints(ts, sma(values, params.smoothing)) : [],
        line: params.line,
        avgColor: params.avg
    }
}

atrIndi.draw = function(s) {
    const out = [
        fillBetween(s.atr, 0, { mode: 'solid', color: s.line + '14' }),
        drawLine(s.atr, s.line, 2)
    ]

    if (s.avg.length) out.push(drawLine(s.avg, s.avgColor, 1, [4, 4]))
    return out
}`;
