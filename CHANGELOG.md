# Changelog

Depth is pre-1.0. Minor versions may break the public API; 1.0 is the freeze.
Anything not exported from `@christtrade/depth` is internal and can change in a
patch without a note here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.12.25] - 2026-08-20

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
  `SweepBudget` types. A sweep UI has to show the combination count and refuse
  an impossible grid *before* posting it, using the same arithmetic the worker
  will. The budget is combinations * bars: neither one alone predicts a hang.
- Walk-forward: `planWalkForward`, `walkForwardEfficiency`,
  `parameterStability` and `pickBest`, with `WalkForwardSpec`,
  `WalkForwardWindow`, `WalkForwardWindowResult` and `ParameterStability`.
  Efficiency is measured per bar so a long anchored window cannot dominate the
  average, out-of-sample segments get no warmup from in-sample,
  and a non-finite objective is skipped rather than chosen - profit factor is
  `Infinity` for a window with no loser, which is noise dressed as perfection.
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
  playhead. Deliberately not `recenterViewOnHorizon`: that one follows the
  playhead and bails when the target is already on screen, because a replay
  stepping forward should not yank the view. This one is a command - someone
  clicked a trade and asked to see it - so it always moves. A span shorter than
  twenty bars recentres at the current zoom instead of fitting to a single
  wick.
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
