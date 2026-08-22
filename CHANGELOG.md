# Changelog

Depth is pre-1.0. Minor versions may break the public API; 1.0 is the freeze.
Anything not exported from `@christtrade/depth` is internal and can change in a
patch without a note here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.13.0] - 2026-08-22

### Added
- **Auditing a plugin's performance.** Opt-in - normal runs aren't touched,
  but a run under audit wraps and timing every line and function call.
  `plugin:audit-run` (`{ id }`) starts it; `plugin:audit-result` returns `{ id, result }`
  (`result: AuditResult`) unless it failed, in which case `plugin:audit-error` reports `{ id, error }`.
  Took one test strategy from ~20k to 70k+ bars/s once the slow parts were visible.
  Auditing only works for indicator, strategy, and chart type plugins. 

## [0.12.26] - 2026-08-21

### Added

- **Intrabar fill resolution in the strategy engine.** `beginBar(bar, index, sub?)`
  takes an optional third argument: the same period at a finer resolution.
  Pending orders and bracket exits resolve against each sub-bar in turn instead
  of the aggregate, so a bar holding both a stop and a target can say which came
  first. The script still gets one `update()` per chart bar - it was written for
  that tf, and calling it 60x more often would change what the strategy *is*,
  not just how precisely it fills.

- `reconcileIntrabar(bar, sub, tolerance)` guards it: a sub-bar whose
  open/high/low/close/timestamp ordering disagrees with the aggregate is
  rejected and that bar falls back to the aggregate, rather than resolving a
  stop against a range that's missing the second the price actually traded
  through.

- `StrategyStats` gains `intrabarBars`, `intrabarFallbacks` and
  `ambiguousExits`; `StrategyTrade` gains `ambiguousExit`. A trade log that
  hides which exits were guessed is how a backtest ends up better than the
  account.

- **A run range for strategies.** `plugin:strategy-range` (`{ id, range }`)
  bounds a strategy to a span of time and re-runs it; `range: null` clears it.
  Runs, sweeps and walk-forward all use the same range, which is a **sibling of
  the parameters, never one of them** - a server runner keys its chunk cache on
  `hash(script + params) + chunkIndex`, so folding range into params would turn
  every range change into a total cache miss.

- `clipRange`, `hasRange`, `emptyRangeReason`, `StrategyRange`, `ClippedRange` -
  a host can resolve a range against bars it already holds and say "that range
  holds no data" without a worker round trip.

- `plugin:strategy-updated` now reports the `range` a run actually covered, and
  a run whose range holds no bars is refused with a reason rather than an empty
  result - so a strategy that took no trades doesn't look the same as one given
  no bars.

- **A strategy can now run over a range the chart has never loaded.**
  `plugin:strategy-range`'s `fetch` flag walks the span a chunk at a time,
  feeding each through the engine and dropping it - progress on
  `plugin:strategy-progress`, result on `plugin:strategy-updated`. Nothing ever
  holds the whole span, and the walk follows the adapter's `coveredTo` rather
  than assuming it got what it asked for, so chunks can't be skipped silently.
  Opt-in, since clipping to loaded bars is free and covers almost every range
  anyone picks, while this one goes to the network.

- `PluginContext.fetchRange` (behind `data:read`) and `DataEngine.fetchRangeBars`
  do that fetch without joining it to the chart's loaded range - it won't scroll
  the view or make the next pan believe it already has history it doesn't.

- A `date` ParamDef type, rendered as a native date/`datetime-local` control.
  Value is an ISO 8601 string rather than a nanosecond number, since params
  persist as JSON with the chart and a bigint doesn't survive that.

- **`planChunks` and `streamRangeChunks`** in `strategy-stream.ts`, walking a
  span in order with several requests on the wire at once. Boundaries are
  decided up front since a request has to be issued before its predecessor
  answers; bars still reach the engine strictly in order, and a failure is
  raised in *plan* order rather than when it happened, so a later chunk failing
  can't skip the bars an earlier, still-outstanding one owns. Concurrency depth
  is 4 - a few MB for roughly a 4x cut in wall clock, where 40 would be most of
  a tab for little more. No DOM, no chart imports, same as the rest of the
  strategy core.

### Changed

- **`plugin:strategy-progress` now describes the whole run, not just the
  fetch.** `phase` gains `running` (every chunk's at the worker, engine
  finishing up and computing stats) and `analysing` (host turning the result
  into whatever it draws); `done` now fires when the numbers exist, not when
  the last chunk was sent. The old contract ended at "fetched", which on a five
  year run is seconds before anything on screen changes - a panel clearing its
  progress on that event looked finished while the tab was still busy.
  `analysing` is emitted by the host, not depth, since depth has no idea what a
  host does with a result. A refused run and an abandoned stream are terminal
  too, and now say so.

- **A strategy run's memory no longer grows with its range.** Drawdown, ulcer
  index, Sharpe, Sortino, CAGR are now accumulated per bar as the run proceeds,
  so the stored equity curve is capped at 8,192 points and thinned as the run
  outgrows it. Measured over a two million bar run: **221 MB before, 1.1 MB
  after**, flat rather than linear in range. The numbers themselves are
  unchanged - Sharpe/Sortino are still taken from the true per-bar sequence, not
  the thinned curve, and use Welford rather than sums of squares since the
  naive form loses precision over a couple million bars. `StrategyResult.equity`
  still covers the whole run but is no longer one point per bar past the cap -
  read `stats.totalBars` for the count.

- Excursion is tracked per sub-bar when intrabar data is in use: a position
  opened partway through a bar no longer inherits the range it wasn't open for
  (a stop filling at 105 on a bar that dipped to 90 beforehand used to report a
  15 point adverse excursion instead of the entry second's own range). MAE/MFE
  timestamps land on the second rather than the whole bar.

## [0.12.25] - 2026-08-20

(this should really have bumped the minor version... didnt think about that, whoops)

### Added

- **Strategy plugins.** `PluginType.strategy` is a fifth plugin type, sibling to
  indicator / drawing / chart type / extension. A strategy is an indicator that
  returns trades instead of a series: it registers, draws and takes parameters
  exactly like one, and lives in the same list.

  ```js
  const s = plugin({
      name: 'MA Cross',
      type: PluginType.strategy,
      lookback: 120,                                        // trailing bars each update() sees
      strategy: { initialCapital: 50000, commission: 2.5 }, // defaults, editable in the settings dialog
      params: { fast: { label: 'Fast', type: 'stepperInt', default: 10 } },
  });

  s.init = ({ params }) => ({ /* ... */ });
  s.update = ({ bar, index, history, state, params, broker }) => { /* ... */ };
  s.draw = (state) => [ /* ... */ ]; // optional - entry/exit markers by default
  ```

  Fill model:

  - An order placed on bar `i` fills on bar `i+1`. Acting on a close you have
    already read is lookahead, and there is no option to switch it off.
  - A bar containing both the stop and the target takes the stop. An aggregate
    bar cannot say which came first, and guessing in the trader's favour is how
    a backtest ends up better than the account.
  - `pyramiding` defaults to 1, so a condition that stays true for twenty bars
    opens one position rather than twenty.
  - R-multiples are `undefined`, not `0`, on a trade that carried no stop, and
    so is `efficiency` on a trade that never moved in favour.
  - `totalSlippage` is reported rather than deducted - it is already inside the
    fill prices.

  Contract details resolve `DEFAULT_STRATEGY_CONFIG` → `SymbolInfo.contract` →
  the script's `strategy` block → `params`. The instrument sits *below* the
  author on purpose: a script that states its own tick value means it.

- `StrategyEngine` and `DEFAULT_STRATEGY_CONFIG`, so a host can score a run
  outside the chart - a test harness, a batch job, or a server runner. The
  engine imports nothing at all, and `build/probe-script-runtime.mjs` fails the
  build if that ever stops being true.
- `StrategyStats` carries the run summary: the usual P/L and drawdown figures
  plus Sortino, Calmar, recovery factor, ulcer index, SQN, Kelly and CAGR;
  streaks and hold times; R-multiples and average exit efficiency over the
  trades that had a stop; average MAE and MFE; and a long/short split.
  Every risk-adjusted figure falls back to `0` rather than `NaN` or `Infinity`.
- The sweep vocabulary: `expandGrid`, `axisValues`, `checkSweepBudget`,
  `splitIndex`, `MAX_SWEEP_COMBOS` (20,000), `MAX_SWEEP_BAR_ITERATIONS`
  (200,000,000) and the `SweepAxis`, `SweepSpec`, `SweepResult` and
  `SweepBudget` types - so a sweep UI can refuse an impossible grid *before*
  posting it, with the same arithmetic the worker uses. Budget is combinations
  × bars; neither alone predicts a hang.
- Walk-forward: `planWalkForward`, `walkForwardEfficiency`,
  `parameterStability` and `pickBest`, with `WalkForwardSpec`,
  `WalkForwardWindow`, `WalkForwardWindowResult` and `ParameterStability`.
  Efficiency is per bar so a long anchored window can't dominate the average,
  out-of-sample segments get no in-sample warmup, and a non-finite objective is
  skipped rather than chosen - `Infinity` profit factor is noise dressed as
  perfection.
- `ExitReason` in the script DSL - `signal`, `stop`, `target`, `reverse`,
  `end-of-data` - so a script can compare against a name instead of a string
  literal.
- `@christtrade/depth/script-runtime` re-exports the engine, the sweep helpers
  and the walk-forward helpers, and adds `defaultStrategyDraw`, the markers a
  strategy gets when it declares no `draw`. The entry point stays DOM-free: the
  point is that the browser worker and any other host execute this exact
  module, rather than two implementations that agree today.
- `chart:goto-range` (`{ fromNs, toNs?, padding? }`) and `gotoRange()` on the
  `useChartData` result, which frames a span of time without touching the
  playhead. Not `recenterViewOnHorizon` - that one follows the playhead and
  bails if the target's already on screen, so replay doesn't get yanked around;
  this one's a command, someone clicked a trade, so it always moves. A span
  shorter than twenty bars recentres at the current zoom instead of fitting to
  a single wick.
- `plugin:apply-params` (`{ id, params }`), which writes values into any
  scripted indicator's settings, not only a strategy's. Keys the plugin does
  not declare are dropped rather than written - a sweep grid can carry keys
  belonging to a strategy that is no longer the selected one, and silently
  storing those corrupts the settings.
- The `plugin:strategy-*` events: `-updated` (stats, trades, equity, any open
  position, the parameters that produced them, and the parameter declarations
  so a sweep UI can offer a range without the author declaring one), and the
  `-sweep` and `-walkforward` families, each with a command, `-cancel`,
  `-progress`, `-done`, `-cancelled` and `-rejected`. `plugin:strategy-rejected`
  reports a run refused for exceeding the in-browser cap of 2,000,000 bars.
- A **Strategies** category in the plugin manager dialog.

### Changed

- The `PluginType` union gains `'strategy'`. Additive for anything that merely
  reads a plugin type, but an exhaustive `switch` over it now wants a fifth
  case.
- A strategy's settings dialog is generated: initial capital, commission,
  slippage, pyramiding and reverse-on-opposite-signal appear without the script
  declaring anything, and a `params` entry of the same name still wins. Tick
  size, contract size and quantity step are deliberately left out - they
  describe the instrument, and putting them in a dialog invites someone to
  "fix" a multiplier until the numbers look better.

### Fixed

- Not user-visible: the server-safety probe matched DOM markers as substrings,
  and a bare `window.` was ambiguous. A walk-forward result carries a `window`
  field describing a span of bars, so `r.window.isTo` failed a DOM check with
  no DOM within reach. The markers now match only what the real global is
  followed by.

## [0.12.24] - 2026-08-19

### Changed

- `indicator-stdlib.ts` imported `LiveTransformer` instead of just its type, causing
  the chart engine to follow with.

### Added

- `script-runtime.ts`, first step of support for strategy plugin types. If the strategy
  is to be ran on the server, there is no DOM. This is the entry point for running scripts
  without a DOM.

## [0.12.23] - 2026-08-18

### Changed

- **Breaking:** the `SymbolIcon` *type* is now `SymbolIconSpec`. The name
  `SymbolIcon` belongs to the React component that renders one, which is now
  exported too. A type and a value cannot share a name across a barrel
  re-export, and in a React library the component has the better claim to the
  plain name.

  ```ts
  import { SymbolIcon, type SymbolIconSpec } from '@christtrade/depth';
  ```

  Only affects code written against 0.12.22, which exported the type for a few
  hours.

### Added

- `toTransferableSymbolInfo`, for stripping `icon` off a `SymbolInfo` before it
  crosses a `postMessage` boundary. An icon may carry a `render` callback, and
  functions do not survive structured clone.
- `SymbolIcon`, the component that renders a `SymbolIconSpec`.

## [0.12.22] - 2026-08-18

### Added

- The trading domain is exported: `Order`, `Fill`, `Position`, `PositionClose`,
  `PositionSide`, `CloseReason`, `TimeInForce`, the bracket and commission
  types, and `getTickValue`, `calcUnrealizedPnl`, `calcUnrealizedPnlPct`,
  `formatPnl`, `formatPnlPct`. `IExecutionAdapter` already required these in
  its signatures, so implementing the documented extension point was impossible
  without them.
- The rest of the extension-point vocabulary, ~68 names that appeared in
  exported signatures but could not be named: `BarResponse`, `FetchRequest`,
  `DataAdapterError`, `TimeRange`, `SupplementalBarSet`, `BarPreviewResponse`,
  `PreProcessedPayload` and `makeTimeRange` / `nsToIso` / `isoToNs` for adapter
  authors; the `IChartPlugin` vocabulary (`ToolbarItem`, `PaneOptions`,
  `SettingSchema`, `PluginStorage`, `ThemeDef` and the rest) for plugin
  authors; the ledger types on `AccountManager`; and the payload types needed
  to write a `ChartEvents` handler.

### Fixed

- The order panel no longer requests `/icon-star.ico` from the host app. The
  icon is inlined as a data URI, the same way the attribution banner and Inter
  already were. It 404'd in every application except ChristTrade's.

## [0.12.21] - 2026-08-18

First public release. Apache-2.0.

### Added

- Everything: 12 chart types, ~50 drawing tools, 21 built-in indicators,
  multi-pane and multi-chart layouts, playback, the order ticket and local L3
  matching engine, session handling, serialization, the plugin runtime (scripted
  and WASM) and bring-your-own-key data sources.

### Fixed

Not user-visible, but this is what the split out of the monorepo turned up:

- Three Radix packages used by live components were never declared as
  dependencies. They resolved only through the monorepo's hoisted
  `node_modules`; a standalone install could not build.
- There was no `devDependencies` block at all - `esbuild`, `jsdom`,
  `tailwindcss`, `tailwindcss-animate` and `typescript` were all inherited from
  the parent workspace.
- `tsconfig.json` extended the host application's Next.js config, which does
  not exist in this repo.
- Inter is embedded in `depth.css`, so its SIL Open Font License now ships
  alongside it.
- 30 unused UI components were removed, taking `depth.css` from 147 KB to
  124 KB.

[unreleased]: https://github.com/christtrade/depth/compare/v0.12.25...HEAD
[0.12.25]: https://github.com/christtrade/depth/compare/v0.12.24...v0.12.25
[0.12.24]: https://github.com/christtrade/depth/compare/v0.12.23...v0.12.24
[0.12.23]: https://github.com/christtrade/depth/compare/v0.12.22...v0.12.23
[0.12.22]: https://github.com/christtrade/depth/compare/v0.12.21...v0.12.22
[0.12.21]: https://github.com/christtrade/depth/releases/tag/v0.12.21
