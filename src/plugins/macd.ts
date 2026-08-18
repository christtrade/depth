export const macdIndi = `
const macdIndi = plugin({
    name: "MACD",
    shortName: "MACD",
    description: "Moving average convergence / divergence",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 200,
    params: {
        fast:   { label: "Fast", type: "number", default: 12, min: 1, max: 400 },
        slow:   { label: "Slow", type: "number", default: 26, min: 1, max: 600 },
        signal: { label: "Signal", type: "number", default: 9, min: 1, max: 200 },
        macdColor:   { label: "MACD", type: "color", default: "#08b3de" },
        signalColor: { label: "Signal", type: "color", default: "#f5a623" }
    }
})

const UP = "#26a69a"
const DOWN = "#ef5350"

macdIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const { macd: line, signal, histogram } = macd(bars, params.fast, params.slow, params.signal)

    // Four-tone histogram: shade by sign, brightness by whether it's growing.
    const hist = []
    const colors = []
    for (let i = 0; i < histogram.length; i++) {
        const v = histogram[i]
        if (isNaN(v)) continue
        const growing = i === 0 || isNaN(histogram[i - 1]) || Math.abs(v) >= Math.abs(histogram[i - 1])
        hist.push({ t: ts[i], price: v })
        colors.push((v >= 0 ? UP : DOWN) + (growing ? 'ff' : '66'))
    }

    return {
        line: toPoints(ts, line),
        signal: toPoints(ts, signal),
        hist,
        colors,
        macdColor: params.macdColor,
        signalColor: params.signalColor
    }
}

macdIndi.draw = function(s) {
    return [
        drawHistogram(s.hist, s.colors, 0, 0.25),
        drawHLine(0, "#ffffff1f", 1),
        drawLine(s.line, s.macdColor, 2),
        drawLine(s.signal, s.signalColor, 1)
    ]
}`;
