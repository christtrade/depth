export const mfiIndi = `
const mfiIndi = plugin({
    name: "Money Flow Index",
    shortName: "MFI",
    description: "Volume-weighted RSI of the typical price",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 100,
    params: {
        length:     { label: "Length", type: "number", default: 14, min: 2, max: 200 },
        overbought: { label: "Overbought", type: "number", default: 80, min: 50, max: 100 },
        oversold:   { label: "Oversold", type: "number", default: 20, min: 0, max: 50 },
        line:       { label: "MFI", type: "color", default: "#26a69a" }
    }
})

mfiIndi.init = function({ data, params }) {
    const bars = data.ohlcv

    return {
        mfi: toPoints(bars.map(b => b.ts), mfi(bars, params.length)),
        overbought: params.overbought,
        oversold: params.oversold,
        line: params.line
    }
}

mfiIndi.draw = function(s) {
    return [
        fillBetween(s.overbought, s.oversold, { mode: 'solid', color: '#ffffff08' }),
        drawHLine(s.overbought, "#ffffff1f", 1, [4, 4]),
        drawHLine(s.oversold, "#ffffff1f", 1, [4, 4]),
        drawLine(s.mfi, s.line, 2)
    ]
}`;
