export const cciIndi = `
const cciIndi = plugin({
    name: "Commodity Channel Index",
    shortName: "CCI",
    description: "Typical price against its mean deviation",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    layout: Layout.pane,
    version: "1.0.0",
    lookback: 100,
    params: {
        length: { label: "Length", type: "number", default: 20, min: 2, max: 300 },
        level:  { label: "Level", type: "number", default: 100, min: 10, max: 400 },
        line:   { label: "CCI", type: "color", default: "#08b3de" }
    }
})

cciIndi.init = function({ data, params }) {
    const bars = data.ohlcv
    const values = cci(bars, params.length)

    return {
        cci: toPoints(bars.map(b => b.ts), values),
        level: params.level,
        line: params.line
    }
}

cciIndi.draw = function(s) {
    return [
        fillBetween(s.level, -s.level, { mode: 'solid', color: '#ffffff08' }),
        drawHLine(s.level, "#ffffff1f", 1, [4, 4]),
        drawHLine(0, "#ffffff12", 1),
        drawHLine(-s.level, "#ffffff1f", 1, [4, 4]),
        drawLine(s.cci, s.line, 2)
    ]
}`;
