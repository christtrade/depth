export const stochasticIndi = `
const stochastic = plugin({
    name: "Stochastic",
    shortName: "STOCH",
    description: "Close relative to the recent high / low range",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 100,
    params: {
        k:      { label: "%K length", type: "number", default: 14, min: 1, max: 200 },
        smooth: { label: "%K smoothing", type: "number", default: 3, min: 1, max: 50 },
        d:      { label: "%D length", type: "number", default: 3, min: 1, max: 50 },
        overbought: { label: "Overbought", type: "number", default: 80, min: 50, max: 100 },
        oversold:   { label: "Oversold", type: "number", default: 20, min: 0, max: 50 },
        kColor: { label: "%K", type: "color", default: "#08b3de" },
        dColor: { label: "%D", type: "color", default: "#f5a623" }
    }
})

stochastic.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const { k, d } = stoch(bars, params.k, params.d, params.smooth)

    return {
        k: toPoints(ts, k),
        d: toPoints(ts, d),
        overbought: params.overbought,
        oversold: params.oversold,
        kColor: params.kColor,
        dColor: params.dColor
    }
}

stochastic.draw = function(s) {
    return [
        fillBetween(s.overbought, s.oversold, { mode: 'solid', color: '#ffffff08' }),
        drawHLine(s.overbought, "#ffffff1f", 1, [4, 4]),
        drawHLine(s.oversold, "#ffffff1f", 1, [4, 4]),
        drawLine(s.d, s.dColor, 1),
        drawLine(s.k, s.kColor, 2)
    ]
}`;
