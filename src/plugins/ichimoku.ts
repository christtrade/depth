export const ichimokuIndi = `
const ichimoku = plugin({
    name: "Ichimoku Cloud",
    shortName: "ICH",
    description: "Tenkan, Kijun and the forward-projected kumo",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 200,
    params: {
        conversion: { label: "Conversion", type: "number", default: 9, min: 1, max: 200 },
        base:       { label: "Base", type: "number", default: 26, min: 1, max: 400 },
        spanB:      { label: "Span B", type: "number", default: 52, min: 1, max: 600 },
        displace:   { label: "Displacement", type: "number", default: 26, min: 0, max: 200 },
        lagging:    { label: "Lagging span", type: "checkbox", default: true }
    }
})

const TENKAN = "#08b3de"
const KIJUN  = "#ef5350"
const SPAN_A = "#26a69a"
const SPAN_B = "#f5a623"
const LAG    = "#9d8cd6"

function midChannel(highs, lows, period) {
    const hi = highest(highs, period)
    const lo = lowest(lows, period)
    const out = new Array(highs.length)
    for (let i = 0; i < out.length; i++) out[i] = (hi[i] + lo[i]) / 2
    return out
}

ichimoku.init = function({ data, barNs, params }) {
    const bars = data.ohlcv
    const n = bars.length
    if (!n) return { tenkan: [], kijun: [], spanA: [], spanB: [], lagging: [], cloud: [] }

    const highs = bars.map(b => b.high)
    const lows = bars.map(b => b.low)

    const tenkan = midChannel(highs, lows, params.conversion)
    const kijun = midChannel(highs, lows, params.base)
    const spanBRaw = midChannel(highs, lows, params.spanB)
    const spanARaw = new Array(n)
    for (let i = 0; i < n; i++) spanARaw[i] = (tenkan[i] + kijun[i]) / 2

    // The kumo is plotted \`displace\` bars ahead, so the last stretch sits past
    // the newest bar - those timestamps have to be extrapolated from barNs.
    const shift = barNs > 0n ? params.displace : 0
    const tsAt = i => i < n ? bars[i].ts : bars[n - 1].ts + BigInt(i - n + 1) * barNs

    // Both spans are pushed together so the two arrays stay index-aligned -
    // cloudRuns pairs them positionally.
    const spanA = []
    const spanB = []
    for (let i = 0; i < n; i++) {
        if (isNaN(spanARaw[i]) || isNaN(spanBRaw[i])) continue
        const t = tsAt(i + shift)
        spanA.push({ t, price: spanARaw[i] })
        spanB.push({ t, price: spanBRaw[i] })
    }

    const lagging = []
    if (params.lagging) {
        for (let i = shift; i < n; i++) lagging.push({ t: bars[i - shift].ts, price: bars[i].close })
    }

    return {
        tenkan: toPoints(bars.map(b => b.ts), tenkan),
        kijun: toPoints(bars.map(b => b.ts), kijun),
        spanA,
        spanB,
        lagging,
        cloud: cloudRuns(spanA, spanB)
    }
}

// Split the kumo where A and B cross so each run can be filled on its own.
function cloudRuns(spanA, spanB) {
    const len = spanA.length
    const runs = []
    let start = 0

    for (let i = 1; i < len; i++) {
        const before = spanA[i - 1].price >= spanB[i - 1].price
        if ((spanA[i].price >= spanB[i].price) === before) continue
        runs.push({ a: spanA.slice(start, i), b: spanB.slice(start, i), bullish: before })
        start = i
    }

    if (start < len) {
        runs.push({
            a: spanA.slice(start),
            b: spanB.slice(start),
            bullish: spanA[start].price >= spanB[start].price
        })
    }

    return runs
}

ichimoku.draw = function(s) {
    const out = []

    for (const run of s.cloud) {
        out.push(fillBetween(run.a, run.b, {
            mode: 'solid',
            color: run.bullish ? SPAN_A + '20' : SPAN_B + '20'
        }))
    }

    out.push(drawLine(s.spanA, SPAN_A, 1))
    out.push(drawLine(s.spanB, SPAN_B, 1))
    out.push(drawLine(s.kijun, KIJUN, 1))
    out.push(drawLine(s.tenkan, TENKAN, 1))
    if (s.lagging.length) out.push(drawLine(s.lagging, LAG, 1, [3, 3]))

    return out
}`;
