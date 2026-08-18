# Changelog

Depth is pre-1.0. Minor versions may break the public API; 1.0 is the freeze.
Anything not exported from `@christtrade/depth` is internal and can change in a
patch without a note here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- There was no `devDependencies` block at all — `esbuild`, `jsdom`,
  `tailwindcss`, `tailwindcss-animate` and `typescript` were all inherited from
  the parent workspace.
- `tsconfig.json` extended the host application's Next.js config, which does
  not exist in this repo.
- Inter is embedded in `depth.css`, so its SIL Open Font License now ships
  alongside it.
- 30 unused UI components were removed, taking `depth.css` from 147 KB to
  124 KB.

[unreleased]: https://github.com/christtrade/depth/compare/v0.12.23...HEAD
[0.12.23]: https://github.com/christtrade/depth/compare/v0.12.22...v0.12.23
[0.12.22]: https://github.com/christtrade/depth/compare/v0.12.21...v0.12.22
[0.12.21]: https://github.com/christtrade/depth/releases/tag/v0.12.21
