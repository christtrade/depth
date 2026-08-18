export const vwapIndi = `
const vwapIndi = plugin({
    name: "VWAP",
    shortName: "VWAP",
    description: "Session volume-weighted average with deviation bands",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 300,
    params: {
        anchorHour: { label: "Session start (UTC)", type: "number", default: 0, min: 0, max: 23 },
        bands:      { label: "Band multipliers", type: "text", default: "1, 2", placeholder: "1, 2, 3" },
        line:       { label: "VWAP", type: "color", default: "#f5a623" },
        band:       { label: "Bands", type: "color", default: "#08b3de" }
    }
})

const DAY_MS = 86400000

function parseMultipliers(raw) {
    const out = []
    for (const part of String(raw).split(',')) {
        const v = parseFloat(part)
        if (isFinite(v) && v > 0) out.push(v)
    }
    return out.slice(0, 4)
}

vwapIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const mults = parseMultipliers(params.bands)

    const vwap = []
    const bands = mults.map(() => ({ upper: [], lower: [] }))

    let sumPV = 0, sumV = 0, sumPPV = 0, session = NaN

    for (const bar of bars) {
        const ms = Number(bar.ts / 1000000n)
        const day = Math.floor((ms - params.anchorHour * 3600000) / DAY_MS)
        if (day !== session) {
            sumPV = 0; sumV = 0; sumPPV = 0
            session = day
        }

        const tp = (bar.high + bar.low + bar.close) / 3
        sumPV += tp * bar.volume
        sumV += bar.volume
        sumPPV += tp * tp * bar.volume
        if (sumV <= 0) continue

        const mean = sumPV / sumV
        vwap.push({ t: bar.ts, price: mean })

        // Volume-weighted variance, so the bands widen with participation.
        const sd = Math.sqrt(Math.max(0, sumPPV / sumV - mean * mean))
        for (let i = 0; i < mults.length; i++) {
            bands[i].upper.push({ t: bar.ts, price: mean + mults[i] * sd })
            bands[i].lower.push({ t: bar.ts, price: mean - mults[i] * sd })
        }
    }

    return { vwap, bands, line: params.line, band: params.band }
}

vwapIndi.draw = function(s) {
    const out = []

    for (let i = s.bands.length - 1; i >= 0; i--) {
        out.push(fillBetween(s.bands[i].upper, s.bands[i].lower, {
            mode: 'solid',
            color: s.band + '0c'
        }))
    }
    for (const b of s.bands) {
        out.push(drawLine(b.upper, s.band + '80', 1, [3, 3]))
        out.push(drawLine(b.lower, s.band + '80', 1, [3, 3]))
    }

    out.push(drawLine(s.vwap, s.line, 2))
    return out
}`;
