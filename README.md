<h1>ChristTrade Depth</h1>

A trading chart for React: canvas rendering, a plugin and scripting runtime,
a strategy backtester, and a local L3 matching engine. It's the chart behind
[ChristTrade](https://christtrade.com).

Depth ships the whole terminal, not drawing primitives: toolbar, symbol
switcher, drawing tools, indicators, order ticket, playback and settings. You
pass it an `IDataAdapter` and a container with a height.

`depth.mjs` is ~1.2 MB minified. React 18 or 19 is the only peer dependency;
Radix, Lucide, Luxon, the workers and the fonts are bundled. If you need a 45 KB
line plotter, use [Lightweight Charts](https://github.com/tradingview/lightweight-charts)
instead.

## Install

```bash
npm i @christtrade/depth
npm i react react-dom   # if you don't already have them
```

## Quick start

`SimulatedMarketAdapter` generates synthetic data, so this runs without a data
source:

```jsx
import { useDepthChart, SimulatedMarketAdapter } from '@christtrade/depth';
import '@christtrade/depth/depth.css';

export default function MyChart() {
    const { chart, element } = useDepthChart({
        dataAdapter: new SimulatedMarketAdapter(),
        // must match what the adapter resolves. a symbol it doesn't know leaves
        // the chart stuck on "Getting market data..."
        symbol: 'SIM-MARKET',
        horizon: Date.now(),
        initialLoad: {
            start: Date.now() - 1000 * 60 * 60 * 24,
            end: Date.now(),
        },
    });

    return <div style={{ width: '100%', height: '100%' }}>{element}</div>;
}
```

`element` is the chart. `chart` is the controller: timeframes, symbols,
drawings, plugins, `serialize()` / `restore()`. Types ship with the package.

### Setup gotchas

- The chart fills its container. `height: auto` collapses it to 0.
- Dark mode is a `dark` class on any ancestor or on `<html>`. Without it you
  get the light theme.
- `depth.css` includes Tailwind preflight (a CSS reset). If it fights your
  styles, import `@christtrade/depth/depth.nopreflight.css` instead.
- Workers are embedded as blob URLs, so a strict CSP needs `worker-src blob:`.
- From `npm create vite`: add `class="dark"` to `<html>` and drop
  `import './index.css'` from `main.jsx`. The template centres and pads
  `#root`.

## Features

- Chart types: candles, hollow candles, Heikin-Ashi, bars, line, area, step,
  baseline, and footprint on L3 data. Plugins can register more.
- Drawing tools: trend line, ray, extended line, horizontal and vertical
  lines and rays, cross line, info line, trend angle, parallel channel, Fib
  retracement, rectangle, triangle, text, long/short position and fixed
  volume profile.
- 21 built-in indicators, written against the same plugin API third parties
  get.
- Multi-pane and multi-chart layouts with synced crosshairs.
- Playback: scrub, step and replay sessions bar by bar.
- Trading: order ticket, quick-trade buttons, positions and P&L on the chart,
  and a local L3 matching engine with real fee schedules for simulated fills.
- Sessions: trading hours, holidays and subsessions. Closed time is cut out
  of the x axis.
- Themes: built-in dark and light themes, or register your own.

## Architecture

### Data

An `IDataAdapter` implements `resolveSymbol`, `searchSymbols` and
`fetchBars`, plus optional `subscribeRealtime` and `getCapabilities`. Each
adapter declares the data level it serves:

| Level | Data | Also serves |
| --- | --- | --- |
| `l3` | MBO events | `tick`, `ohlcv`, `l2` |
| `tick` | trades | `ohlcv` |
| `ohlcv` | bars | |
| `l2` | book snapshots | |

A plugin or feature declares the level it needs, and on a symbol that can't
serve it, it's refused with a reason instead of breaking. The chunk processors
(`processOhlcvChunk`, `processTickChunk`, `processL2Chunk`, `processL3Chunk`)
are exported, so an adapter doesn't reimplement aggregation. Plugins can add
data sources at runtime with `registerDataSource`, which is how
bring-your-own-API-key providers work.

The `DataEngine` keeps one store per symbol and pages history in as you pan.
Every chart on that symbol reads the same store.

### Storage

OHLCV lives in a `BarStore`: six `Float64Array` columns (`time`, `open`,
`high`, `low`, `close`, `volume`, plus bid/ask once a bar has them), sorted by
`time`.

- 48 bytes a bar. A `{ time, open, high, low, close, volume }` object is ~176,
  and each one is something for the GC to walk.
- Capacity doubles on growth, and the spare room is split between both ends,
  so append and prepend are amortized O(bars added). Paging history in never
  copies what's loaded.
- `lowerBound` / `upperBound` binary search on `time`.
- When a chart's timeframe is the resolution the data came in at, the chart
  draws from the engine's store directly. Other timeframes get one
  aggregated copy.

The column views are replaced when the store grows. Read `bars.close` off the
store each time, and key caches on `bars.version`, which bumps on every
mutation.

L3 events are packed into 20 bytes each in a `CompactBuffer` (BigInt64
timestamp, int32 price, uint32 size, uint24 order id, packed action/side), so
30M events take ~600 MB instead of ~5 GB as objects.

### Rendering

Four stacked canvases: `background`, `base` (candles, grid, indicators),
`drawings` and `ui` (crosshair, axis labels, price pills). One rAF loop paints
only the layers marked dirty, so an idle chart costs close to nothing.

Time is BigInt nanoseconds. `SessionMapper` maps real time to "market time",
with closed sessions taken out, and the transformer maps that to pixels.

Per frame, drawing is O(visible bars), and lookups by time (status line,
magnet snap, y-axis autofit) are O(log n) in loaded bars.

### Workers

- `script.worker`: user scripts and strategies, off the main thread.
- `slice.worker`: decodes L3 ranges and merges history pages.
- `heatmap.worker`: builds book snapshots and renders the depth heatmap to an
  `OffscreenCanvas`.
- An indicator worker for heavy indicator math.

## Performance

Ryzen 5 7500F, Chrome, 1m bars.

- 1M bars loaded, ~300 on screen: panning holds 240fps. Draw, status line,
  autofit and snap cost the same as with 20k loaded (see the perf guard
  below).
- Heap with 1M bars loaded, in ChristTrade: ~480 MB.
- Backtest over 2M bars (~4 years of BTC 1m) through the script worker:
  207-265ms. Stats are running (Welford) and the equity curve is capped, so
  it holds ~1.1 MB at 2M bars.
- `processL3Chunk`: ~1.5M MBO events/sec on synthetic data.

### Perf guard

`npm run perf:guard` runs in CI. It bundles the draw, status line, autofit,
snap and prepend paths with esbuild, times each at 20k and at 1M loaded bars
with ~300 on screen, drawing to a no-op canvas, and fails if any is 5x slower
at 1M, or if a `BarStore` paged in to 1M bars takes more than 72 bytes a bar
including spare capacity:

```
ok   draw candles   118.0µs -> 85.4µs  0.7x
ok   status line    0.8µs -> 0.9µs  1.1x
ok   autofit        2.0µs -> 1.9µs  1.0x
ok   magnet snap    1.0µs -> 0.9µs  0.9x
ok   page prepend   0.96ms -> 1.04ms  1.1x
ok   bytes/bar      66.7 at 1M, spare room included (max 72)
```

Left column is 20k bars, right is 1M.

## Plugins

Plugins are JavaScript modules, or scripts written in the built-in editor on
[christtrade.com](https://christtrade.com). They can add indicators, chart
types, drawing tools, panels, toolbar items, data sources and render overlays,
and can offload heavy math to WebAssembly.

A plugin declares the capabilities and network origins it needs, and `ctx`
only exposes those, so you can show a user what a plugin wants before it
runs. It isn't a sandbox: plugin code runs in your page. Read
[SECURITY.md](SECURITY.md) before running other people's plugins.

Strategies run in the script worker. `StrategyEngine` does intrabar fills,
parameter sweeps and walk-forward analysis.

Full docs: [docs.christtrade.com/depth](https://docs.christtrade.com/depth).

## Development

```bash
npm test              # node:test via tsx
npm run perf:guard
npx tsc -p tsconfig.json --noEmit
npm run dist          # build dist/, smoke test it
```

CI runs tests, typecheck and the perf guard on Node 20 and 22.

## Status

Pre-1.0. It runs in production at ChristTrade, but the public API still
moves and minor versions can break it. 1.0 is the API freeze. Breaking changes
are marked in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues are welcome: bug reports, reproductions, API questions.

Pull requests are by invitation. Depth is a single-author library. If you
found something broken, open an issue, and if a PR is the right fix I'll ask
for one. Unsolicited PRs usually get closed and reopened as issues, which
isn't a comment on the code.

## Attribution

Depth draws a small ChristTrade mark in the corner of the chart. Apache-2.0
doesn't require you to keep it, and you can remove it. I'm asking you not to:
it's the only thing the library asks for, and it's how people find it.

The name is separate. Apache-2.0 grants no trademark rights (section 6), so
you can fork Depth but can't ship it as "ChristTrade Depth". See
[NOTICE](NOTICE).

## License

[Apache License 2.0](LICENSE.md) - Copyright 2026 Carl Sterner.
