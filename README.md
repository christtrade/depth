<h1>ChristTrade Depth</h1>

A complete trading chart for React. Canvas-rendered, plugin-scriptable, and
agnostic about where its data comes from.

Depth is the chart that powers [ChristTrade](https://christtrade.com). It is not
a plotting primitive you assemble a UI around - it ships the whole surface:
toolbar, symbol switcher, drawing tools, indicators, order ticket, playback,
settings. You give it a data adapter and a container with a height, and you have
a trading terminal.

## What it is, and what it isn't

`depth.mjs` is about 1.2 MB minified. That's the honest number, and it's the
right one to compare against a TradingView widget rather than against a
lightweight plotting library. If you want 45 KB that draws a line, Depth is the
wrong tool and [Lightweight Charts](https://github.com/tradingview/lightweight-charts)
is a good one. If you want the thing your users already know how to use, keep
reading.

React 18 or 19 is the only runtime dependency you install. Everything else -
Radix, Lucide, Luxon, the workers, the fonts - is compiled in.

## Install

```bash
npm i @christtrade/depth
npm i react react-dom   # if you don't already have them
```

## Quick start

`SimulatedMarketAdapter` generates synthetic market data, so this runs with no
data source wired up:

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
        // additional options...
    });

    return <div style={{ width: '100%', height: '100%' }}>{element}</div>;
}
```

`element` is the chart. `chart` is the controller handle - timeframes, symbols,
drawings, plugins, serialization. Types ship with the package, so your editor
has the full API.

### Four things that trip people up

- **Give the chart a real height.** It fills its container. A container with
  `height: auto` collapses it to nothing.
- **Dark mode is a `dark` class** on any ancestor, or on `<html>`. Without it
  you get the light theme.
- **`depth.css` includes a CSS reset** (Tailwind preflight), which is what you
  want in a fresh app. If it fights your existing styles, import
  `@christtrade/depth/depth.nopreflight.css` instead.
- **Workers are embedded as blob URLs.** Under a strict CSP you need
  `worker-src blob:`.

If you started from `npm create vite`, add `class="dark"` to `<html>` and drop
`import './index.css'` from `main.jsx` - the template stylesheet centres and pads
`#root`, which fights the chart's layout.

## What's in the box

- **12 chart types** - candles, hollow candles, Heikin-Ashi, bars, line, area,
  step, baseline, Renko, Kagi, line break, footprint. Plugins can register more.
- **~50 drawing tools** - trendlines, channels, Fibonacci, Gann, patterns,
  position tools, measurements, annotations.
- **21 built-in indicators**, each written against the same plugin API third
  parties use. There is no privileged internal path.
- **Multi-pane and multi-chart layouts**, with synced crosshairs.
- **Playback** - scrub, step, and replay historical sessions bar by bar.
- **Trading** - order ticket, quick-trade buttons, position and P&L rendering,
  and a local L3 matching engine with real fee schedules for simulated fills.
- **Sessions** - trading hours, holidays, subsessions, correct gaps.
- **Serialization** - `chart.serialize()` / `chart.restore()` round-trips
  layouts, drawings, plugins, and preferences.

## Data

A data source is an `IDataAdapter`. Implement it and pass it in:

```ts
import type { IDataAdapter } from '@christtrade/depth';
```

Depth supports four data levels - OHLCV bars, ticks, L2 book snapshots, and MBO
(L3) events - and each adapter declares which it serves. Higher levels unlock
features that need them (footprint, depth-of-market, per-order replay); lower
levels degrade cleanly rather than breaking. Chunk processors for each level are
exported so adapter authors don't have to reimplement aggregation.

Plugins can also register data sources at runtime via `registerDataSource`,
which is how bring-your-own-API-key providers work.

## Plugins

Plugins are declarative JavaScript, written in the built-in script editor on
[christtrade.com](https://christtrade.com) or shipped as modules. They can add
indicators, chart types, drawing tools, panels, toolbar items, data sources,
and render overlays. Heavy computation can be offloaded to WebAssembly.

A plugin declares the capabilities and network origins it needs, and `ctx` hands
over nothing it did not ask for - so you can show a user what a plugin intends
before they start it. That is a declaration mechanism, not a sandbox: plugin code
runs in your page. Read [SECURITY.md](SECURITY.md) before you let other people's
plugins run in your app.

Full plugin documentation lives at
[docs.christtrade.com/depth](https://docs.christtrade.com/depth).

## Status

Depth is pre-1.0 and versioned accordingly. It runs in production at
ChristTrade, so it is not experimental - but the public API is still moving, and
minor versions may break it. **1.0 is the API freeze**, not the point where the
library becomes usable.

## Contributing

**Issues are welcome.** Bug reports, reproductions, and questions about the API
all help, and I read them.

**Pull requests are by invitation.** Depth is a single-author library and I
intend to keep it that way. If you've found something broken, open an issue -
if a PR is the right way to resolve it, I'll ask. Unsolicited PRs will usually
be closed with thanks and reopened as issues, which isn't a comment on the code.

## Attribution

Depth draws a small ChristTrade mark in the corner of the chart.

The Apache License doesn't require you to keep it, and I'm not going to pretend
otherwise - you can remove it and you'll be within your rights. I'm asking you
not to. The mark is the only thing this library asks in return for being free,
and it's how people find it.

The name is a separate matter. Apache-2.0 grants no trademark rights (section
6), so you can fork Depth but you can't ship it as "ChristTrade Depth." See
[NOTICE](NOTICE).

## License

[Apache License 2.0](LICENSE.md) - Copyright 2026 Carl Sterner.
