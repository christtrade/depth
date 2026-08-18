export const awesomeIndi = `
const awesome = plugin({
    name: "Awesome Oscillator",
    shortName: "AO",
    description: "Fast minus slow median-price average",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 150,
    params: {
        fast: { label: "Fast", type: "number", default: 5, min: 1, max: 200 },
        slow: { label: "Slow", type: "number", default: 34, min: 2, max: 400 },
        up:   { label: "Rising", type: "color", default: "#26a69a" },
        down: { label: "Falling", type: "color", default: "#ef5350" }
    }
})

awesome.init = function({ data, params }) {
    const bars = data.ohlcv
    const hl2 = bars.map(b => (b.high + b.low) / 2)
    const fast = sma(hl2, params.fast)
    const slow = sma(hl2, params.slow)

    const pts = []
    const colors = []
    let prev = NaN

    for (let i = 0; i < bars.length; i++) {
        const v = fast[i] - slow[i]
        if (isNaN(v)) continue
        pts.push({ t: bars[i].ts, price: v })
        colors.push(isNaN(prev) || v >= prev ? params.up : params.down)
        prev = v
    }

    return { pts, colors }
}

awesome.draw = function(s) {
    return [
        drawHistogram(s.pts, s.colors, 0, 0.25),
        drawHLine(0, "#ffffff1f", 1)
    ]
}`;
