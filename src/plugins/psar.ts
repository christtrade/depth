export const psarIndi = `
const psar = plugin({
    name: "Parabolic SAR",
    shortName: "SAR",
    description: "Accelerating stop-and-reverse dots",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 100,
    params: {
        step: { label: "Step", type: "number", default: 0.02, min: 0.001, max: 0.5, step: 0.001 },
        max:  { label: "Max step", type: "number", default: 0.2, min: 0.01, max: 1, step: 0.01 },
        up:   { label: "Rising", type: "color", default: "#26a69a" },
        down: { label: "Falling", type: "color", default: "#ef5350" },
        size: { label: "Dot size", type: "stepperInt", default: 2, min: 1, max: 6 }
    }
})

psar.init = function({ data, params }) {
    const bars = data.ohlcv
    const pts = []
    const colors = []
    if (bars.length < 2) return { pts, colors, size: params.size }

    let rising = bars[1].close >= bars[0].close
    let sar = rising ? bars[0].low : bars[0].high
    let extreme = rising ? bars[1].high : bars[1].low
    let accel = params.step

    for (let i = 1; i < bars.length; i++) {
        const bar = bars[i]
        sar = sar + accel * (extreme - sar)

        // The stop may never sit inside the last two bars' range.
        const prev = bars[i - 1]
        if (rising) {
            sar = Math.min(sar, prev.low, bars[i - 2] ? bars[i - 2].low : prev.low)
        } else {
            sar = Math.max(sar, prev.high, bars[i - 2] ? bars[i - 2].high : prev.high)
        }

        if (rising ? bar.low < sar : bar.high > sar) {
            rising = !rising
            sar = extreme
            extreme = rising ? bar.high : bar.low
            accel = params.step
        } else if (rising ? bar.high > extreme : bar.low < extreme) {
            extreme = rising ? bar.high : bar.low
            accel = Math.min(accel + params.step, params.max)
        }

        pts.push({ t: bar.ts, price: sar })
        colors.push(rising ? params.up : params.down)
    }

    return { pts, colors, size: params.size }
}

psar.draw = function(s) {
    return [drawDots(s.pts, s.colors, s.size)]
}`;
