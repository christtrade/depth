import { StorageKey, readJSON, writeJSON } from '../lib/storage';
import type { PluginType } from '../interfaces/plugins/IChartPlugin';

/**
 * A plugin the host has code for, whether or not it is loaded. Supplied by
 * `chart.setPluginCatalog()`; the chart resolves ids against it when it loads
 * startup plugins and when the plugin manager offers one.
 */
export interface PluginCatalogEntry {
    id: string;
    /** Source, in the chart's plugin scripting language. */
    code: string;
    name?: string;
    type?: PluginType;
    description?: string;
    group?: string;
}

/**
 * What should happen to a plugin when the chart opens.
 *
 * `autostart: false` is a tombstone, not an absence - it says the user turned
 * this plugin off, which a save document restored from another session must not
 * override. An id with no entry at all has no opinion attached.
 */
export interface PluginStartupEntry {
    /** Install the plugin when the chart opens. */
    autostart: boolean;
    /** Indicators only: also put an instance on a pane. */
    activate?: boolean;
}

export type PluginStartupRecord = Record<string, PluginStartupEntry>;

// TEMPORARY: tracing for the "plugins come back after a reload" hunt. enable with
// ?plugintrace in the url. remove once that's settled
export function ptrace(...args: unknown[]): void {
    if (typeof window === 'undefined') return;
    if (!window.location.search.includes('plugintrace')) return;
    console.log('[plugins]', ...args);
}

export function readPluginStartup(): PluginStartupRecord {
    const raw = readJSON<PluginStartupRecord>(StorageKey.pluginStartup, {});
    return raw && typeof raw === 'object' ? raw : {};
}

/** Merge a patch into one plugin's entry. `null` forgets the plugin entirely. */
export function writePluginStartup(
    id: string,
    patch: Partial<PluginStartupEntry> | null,
): PluginStartupRecord {
    const all = readPluginStartup();
    if (patch === null) delete all[id];
    else all[id] = { autostart: false, ...all[id], ...patch };
    writeJSON(StorageKey.pluginStartup, all);
    ptrace('record write', id, patch, '->', JSON.stringify(all[id]));
    return all;
}
