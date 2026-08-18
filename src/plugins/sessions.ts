export const sessionsIndi = `
const sessionsIndi = plugin({
    name: "Trading Sessions",
    shortName: "SESS",
    description: "Asia / London / New York session ranges",
    type: PluginType.indicator,
    require: DataLevel.ohlcv,
    version: "1.0.0",
    params: {
        tz:       { label: "Timezone", type: "select", default: "UTC", options: [
            { value: "UTC", label: "UTC" },
            { value: "America/New_York", label: "New York" },
            { value: "Europe/London", label: "London" },
            { value: "Asia/Tokyo", label: "Tokyo" }
        ] },
        asia:     { label: "Asia", type: "checkbox", default: true },
        london:   { label: "London", type: "checkbox", default: true },
        newYork:  { label: "New York", type: "checkbox", default: true },
        labels:   { label: "Show labels", type: "checkbox", default: true },
        opacity:  { label: "Shading", type: "opacity", default: 12 }
    }
})

const SESSIONS = [
    { key: "asia",    label: "Asia",    startHour: 0,  startMinute: 0,  endHour: 9,  endMinute: 0, color: "#7e57c2" },
    { key: "london",  label: "London",  startHour: 7,  startMinute: 0,  endHour: 16, endMinute: 0, color: "#08b3de" },
    { key: "newYork", label: "New York", startHour: 13, startMinute: 30, endHour: 22, endMinute: 0, color: "#f5a623" }
]

function alpha(hex, percent) {
    const a = Math.round(Math.max(0, Math.min(100, percent)) * 2.55)
    return hex + a.toString(16).padStart(2, '0')
}

sessionsIndi.init = function({ data, params }) {
    const active = SESSIONS.filter(s => params[s.key])
    const bands = active.length
        ? sessionBoundaries(data.ohlcv, active, { tz: params.tz })
        : []

    return { bands, labels: params.labels, opacity: params.opacity }
}

sessionsIndi.draw = function(s) {
    const out = []

    for (const band of s.bands) {
        out.push(drawRect(band.startTs, band.low, band.endTs, band.high, {
            fillColor: alpha(band.color, s.opacity),
            borderColor: alpha(band.color, 55),
            radius: 3
        }))

        if (s.labels) {
            out.push(drawLabel(band.label, band.startTs, band.high, band.color, 10, true, 'left', 'bottom'))
        }
    }

    return out
}`;
