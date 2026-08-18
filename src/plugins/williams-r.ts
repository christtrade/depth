export const williamsRIndi = `
const williams = plugin({
    name: "Williams %R",
    shortName: "%R",
    description: "Where the close sits inside the period's range",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 100,
    params: {
        length:     { label: "Length", type: "number", default: 14, min: 1, max: 300 },
        overbought: { label: "Overbought", type: "number", default: -20, min: -50, max: 0 },
        oversold:   { label: "Oversold", type: "number", default: -80, min: -100, max: -50 },
        line:       { label: "%R", type: "color", default: "#7e57c2" }
    }
})

williams.init = function({ data, params }) {
    const bars = data.ohlcv

    return {
        r: toPoints(bars.map(b => b.ts), williamsR(bars, params.length)),
        overbought: params.overbought,
        oversold: params.oversold,
        line: params.line
    }
}

williams.draw = function(s) {
    return [
        fillBetween(s.overbought, s.oversold, { mode: 'solid', color: '#ffffff08' }),
        drawHLine(s.overbought, "#ffffff1f", 1, [4, 4]),
        drawHLine(s.oversold, "#ffffff1f", 1, [4, 4]),
        drawLine(s.r, s.line, 2)
    ]
}`;
