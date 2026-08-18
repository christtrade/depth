export const volumeIndi = `
const volumeIndi = plugin({
    name: "Volume",
    shortName: "VOL",
    description: "Per-bar volume with a moving average",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 100,
    params: {
        length: { label: "Average", type: "number", default: 20, min: 0, max: 500 },
        up:     { label: "Up bar", type: "color", default: "#26a69a" },
        down:   { label: "Down bar", type: "color", default: "#ef5350" },
        avg:    { label: "Average", type: "color", default: "#f5a623" },
        opacity:{ label: "Bar opacity", type: "opacity", default: 65 }
    }
})

volumeIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const suffix = Math.round(Math.max(0, Math.min(100, params.opacity)) * 2.55).toString(16).padStart(2, '0')

    const pts = []
    const colors = []
    for (const bar of bars) {
        pts.push({ t: bar.ts, price: bar.volume })
        colors.push((bar.close >= bar.open ? params.up : params.down) + suffix)
    }

    return {
        pts,
        colors,
        avg: params.length >= 2
            ? toPoints(bars.map(b => b.ts), sma(bars.map(b => b.volume), params.length))
            : [],
        avgColor: params.avg
    }
}

volumeIndi.draw = function(s) {
    const out = [drawHistogram(s.pts, s.colors, 0, 0.25)]
    if (s.avg.length) out.push(drawLine(s.avg, s.avgColor, 1))
    return out
}`;
