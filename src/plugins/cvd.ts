export const cvdIndi = `
const cvd = plugin({
    name: "Cumulative Volume Delta",
    shortName: "CVD",
    description: "Running aggressor imbalance, bucketed per bar",
    type: PluginType.indicator,
    require: DataLevel.l3,
    layout: Layout.pane,
    version: "1.0.0",
    params: {
        up:   { label: "Rising", type: "color", default: "#26a69a" },
        down: { label: "Falling", type: "color", default: "#ef5350" },
        deltaBars: { label: "Per-bar delta", type: "checkbox", default: true }
    }
})

// Trades arrive as { ts, price, size, side } - 'B' lifted the ask, 'A' hit the bid.
// Everything is folded in place: only the bar the trade lands in is touched, and
// draw() reads the arrays as they stand.
function fold(state, trades) {
    for (const trade of trades) {
        const bar = state.barNs > 0n ? trade.ts / state.barNs * state.barNs : trade.ts
        const signed = trade.side === 'B' ? trade.size : -trade.size
        state.total += signed

        const i = state.pts.length - 1
        if (i >= 0 && state.pts[i].t === bar) {
            state.pts[i].price = state.total
            state.delta[i].price += signed
        } else {
            state.pts.push({ t: bar, price: state.total })
            state.delta.push({ t: bar, price: signed })
            state.lineColors.push(state.up)
            state.barColors.push(state.up)
        }

        const j = state.pts.length - 1
        state.lineColors[j] = j > 0 && state.pts[j].price < state.pts[j - 1].price ? state.down : state.up
        state.barColors[j] = state.delta[j].price >= 0 ? state.upFaded : state.downFaded
    }

    return state
}

cvd.init = function({ data, barNs, params }) {
    return fold({
        pts: [],
        delta: [],
        lineColors: [],
        barColors: [],
        total: 0,
        barNs,
        up: params.up,
        down: params.down,
        upFaded: params.up + '4d',
        downFaded: params.down + '4d',
        deltaBars: params.deltaBars
    }, data.trades)
}

// Only the trades since the last horizon step arrive here, so the running total
// carries forward instead of being rebuilt from scratch.
cvd.update = function({ newData, state }) {
    return { points: {}, state: fold(state, newData.trades) }
}

cvd.draw = function(s) {
    const out = []
    if (s.deltaBars) out.push(drawHistogram(s.delta, s.barColors, 0, 0.3))
    out.push(drawHLine(0, "#ffffff1f", 1))
    out.push(drawLine(s.pts, s.lineColors, 2))
    return out
}`;
