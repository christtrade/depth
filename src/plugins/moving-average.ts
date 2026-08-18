export const maIndi = `
const movingAverage = plugin({
    name: "Moving Average",
    shortName: "MA",
    description: "Fast / slow pair, any method, any source",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 250,
    params: {
        method: { label: "Method", type: "select", default: "EMA", options: [
            { value: "SMA", label: "Simple" },
            { value: "EMA", label: "Exponential" },
            { value: "WMA", label: "Weighted" },
            { value: "HMA", label: "Hull" },
            { value: "RMA", label: "Wilder" }
        ] },
        source: { label: "Source", type: "select", default: "close", options: [
            { value: "close", label: "Close" },
            { value: "open", label: "Open" },
            { value: "high", label: "High" },
            { value: "low", label: "Low" },
            { value: "hl2", label: "HL/2" },
            { value: "hlc3", label: "HLC/3" },
            { value: "ohlc4", label: "OHLC/4" }
        ] },
        fast:      { label: "Fast", type: "number", default: 21, min: 2, max: 1000 },
        slow:      { label: "Slow", type: "number", default: 50, min: 0, max: 1000 },
        fastColor: { label: "Fast", type: "color", default: "#08b3de" },
        slowColor: { label: "Slow", type: "color", default: "#f5a623" },
        width:     { label: "Width", type: "stepperInt", default: 2, min: 1, max: 4 }
    }
})

const SOURCE = {
    close: b => b.close,
    open:  b => b.open,
    high:  b => b.high,
    low:   b => b.low,
    hl2:   b => (b.high + b.low) / 2,
    hlc3:  b => (b.high + b.low + b.close) / 3,
    ohlc4: b => (b.open + b.high + b.low + b.close) / 4
}

const METHOD = { SMA: sma, EMA: ema, WMA: wma, HMA: hma, RMA: rma }

movingAverage.init = function({ data, params }) {
    const bars = data.ohlcv
    const ts = bars.map(b => b.ts)
    const src = bars.map(SOURCE[params.source] || SOURCE.close)
    const avg = METHOD[params.method] || ema

    return {
        fast: toPoints(ts, avg(src, params.fast)),
        slow: params.slow >= 2 ? toPoints(ts, avg(src, params.slow)) : [],
        fastColor: params.fastColor,
        slowColor: params.slowColor,
        width: params.width
    }
}

movingAverage.draw = function(s) {
    const out = [drawLine(s.fast, s.fastColor, s.width)]
    if (s.slow.length) out.push(drawLine(s.slow, s.slowColor, s.width))
    return out
}`;
