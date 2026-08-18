export const rsiIndi = `
const rsiIndi = plugin({
    name: "Relative Strength Index",
    shortName: "RSI",
    description: "Momentum oscillator with overbought / oversold zones",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 150,
    params: {
        length:    { label: "Length", type: "number", default: 14, min: 2, max: 200 },
        smoothing: { label: "Average", type: "number", default: 14, min: 1, max: 200 },
        overbought:{ label: "Overbought", type: "number", default: 70, min: 50, max: 100 },
        oversold:  { label: "Oversold", type: "number", default: 30, min: 0, max: 50 },
        line:      { label: "RSI", type: "color", default: "#7e57c2" },
        signal:    { label: "Average", type: "color", default: "#f5a623" }
    }
})

rsiIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const values = rsi(bars, params.length)

    return {
        rsi: toPoints(ts, values),
        ma: toPoints(ts, sma(values, params.smoothing)),
        overbought: params.overbought,
        oversold: params.oversold,
        line: params.line,
        signal: params.signal
    }
}

rsiIndi.draw = function(s) {
    const grid = "#ffffff1f"

    return [
        fillBetween(s.overbought, s.oversold, { mode: 'solid', color: s.line + '1a' }),

        // Gradients fade out at the threshold, so only the excursion past it shows.
        fillBetween(s.rsi, s.oversold, {
            mode: 'vertical',
            stops: [
                { price: s.oversold, color: 'rgba(239,83,80,0)' },
                { price: 0, color: 'rgba(239,83,80,0.55)' }
            ]
        }),
        fillBetween(s.overbought, s.rsi, {
            mode: 'vertical',
            stops: [
                { price: 100, color: 'rgba(38,166,154,0.55)' },
                { price: s.overbought, color: 'rgba(38,166,154,0)' }
            ]
        }),

        drawHLine(s.overbought, grid, 1, [4, 4]),
        drawHLine(50, "#ffffff12", 1, [4, 4]),
        drawHLine(s.oversold, grid, 1, [4, 4]),

        drawLine(s.ma, s.signal, 1),
        drawLine(s.rsi, s.line, 2)
    ]
}`;
