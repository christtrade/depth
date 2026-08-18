//  Helpers for moving a SymbolInfo across boundaries that can't carry it whole.
import type { SymbolInfo } from '../interfaces/IDataAdapter';

/**
 * A structured-clone-safe copy of a SymbolInfo, with `icon` stripped.
 *
 * `SymbolIconSpec` may carry a `render` callback, and functions cannot cross a
 * `postMessage` boundary - the clone throws before the worker ever sees it.
 * Icons are a presentation concern, so nothing off the main thread needs them.
 *
 * Call this on any SymbolInfo bound for a worker, `structuredClone`, or
 * persisted layout.
 */
export function toTransferableSymbolInfo(info: SymbolInfo): SymbolInfo {
    const { icon: _icon, legendIcon: _legendIcon, subsymbols, ...rest } = info;
    return subsymbols?.length
        ? { ...rest, subsymbols: subsymbols.map(toTransferableSymbolInfo) }
        : rest;
}
