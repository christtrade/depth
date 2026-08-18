export const alligatorIndi = `
const alligatorIndi = plugin({
    name: "Alligator",
    shortName: "ALLI",
    description: "Bill Williams' three displaced balance lines",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    lookback: 100,
    params: {
        jawShift:   { label: "Jaw shift", type: "stepperInt", default: 8, min: 0, max: 50 },
        teethShift: { label: "Teeth shift", type: "stepperInt", default: 5, min: 0, max: 50 },
        lipsShift:  { label: "Lips shift", type: "stepperInt", default: 3, min: 0, max: 50 }
    }
})

const JAW = "#08b3de"
const TEETH = "#ef5350"
const LIPS = "#26a69a"

alligatorIndi.init = function({ data, barNs, params }) {
    const bars = data.ohlcv
    const n = bars.length
    if (!n) return { jaw: [], teeth: [], lips: [] }

    const { jaw, teeth, lips } = alligator(bars)
    const tsAt = i => i < n ? bars[i].ts : bars[n - 1].ts + BigInt(i - n + 1) * barNs

    const shifted = (values, shift) => {
        const step = barNs > 0n ? shift : 0
        const out = []
        for (let i = 0; i < n; i++) {
            if (isNaN(values[i])) continue
            out.push({ t: tsAt(i + step), price: values[i] })
        }
        return out
    }

    return {
        jaw: shifted(jaw, params.jawShift),
        teeth: shifted(teeth, params.teethShift),
        lips: shifted(lips, params.lipsShift)
    }
}

alligatorIndi.draw = function(s) {
    return [
        drawLine(s.jaw, JAW, 1),
        drawLine(s.teeth, TEETH, 1),
        drawLine(s.lips, LIPS, 1)
    ]
}`;
