// every localStorage read and write the chart does goes through here, for two
// reasons.
//
// keys used to be spelled five different ways - christtrade.l3-chart-settings,
// christrade_custom_tfs (sic), drawing_style_templates, ct:drawing-favorites,
// ctc:plugin:<id>. they all live under the one christtrade:chart: namespace now,
// and the legacy ones get migrated across on first access then deleted.
//
// and persistence is opt-out: when the user turns it off nothing is written and
// nothing is read back, so the chart opens like a fresh session instead of
// quietly resurrecting whatever was saved before.

export const STORAGE_NAMESPACE = 'christtrade:chart:';

/**
 * Every chart-owned storage key. Add new keys here rather than inlining string
 * literals at the call site - `clearChartStorage` and the migration both key off
 * this namespace.
 */
export const StorageKey = {
    chartSettings: `${STORAGE_NAMESPACE}settings`,
    customTimeframes: `${STORAGE_NAMESPACE}custom-timeframes`,
    favoriteTimeframes: `${STORAGE_NAMESPACE}favorite-timeframes`,
    drawingTemplates: `${STORAGE_NAMESPACE}drawing-templates`,
    drawingFavorites: `${STORAGE_NAMESPACE}drawing-favorites`,
    colorSwatches: `${STORAGE_NAMESPACE}color-swatches`,
    pluginStartup: `${STORAGE_NAMESPACE}plugin-startup`,
    pluginPanels: `${STORAGE_NAMESPACE}plugin-panels`,
} as const;

/**  sdklaföfkdslfk:Settings blob a plugin owns via `ctx.getSettings()` / `ctx.saveSettings()`. */
export function pluginSettingsKey(pluginId: string): string {
    return `${STORAGE_NAMESPACE}plugin:${pluginId}`;
}

/** Individual entry in a plugin's namespaced KV store (`ctx.storage`). */
export function pluginStorageKey(pluginId: string, key: string): string {
    return `${STORAGE_NAMESPACE}plugin:${pluginId}:${key}`;
}

/** Prefix covering every key belonging to one plugin's KV store. */
export function pluginStoragePrefix(pluginId: string): string {
    return `${STORAGE_NAMESPACE}plugin:${pluginId}:`;
}

/**
 * Bookkeeping about this device rather than user data - one-shot migration
 * markers and the like. Excluded from clearChartStorage() and from the
 * preferences block of a save document, since it means nothing on another device.
 */
export const META_PREFIX = `${STORAGE_NAMESPACE}meta:`;

// Persistence preference
//  Deliberately outside the gate: it has to be readable and writable even when
//  persistence is off, otherwise there'd be no way to switch it back on. It is
//  also exempt from clearChartStorage() for the same reason.

const PERSISTENCE_KEY = `${STORAGE_NAMESPACE}persist`;

/**
 * Session-scoped mirror of every write, ignoring the persistence gate. With
 * persistence on it's a write-through cache; with it off it's the only backing
 * store - see the accessors below.
 */
const memoryStore = new Map<string, string>();

/**
 * Where the chart keeps its settings. localStorage-shaped and synchronous, so a
 * host can point it at something else - an account-level store that syncs to a
 * server, for instance - and everything the chart persists follows.
 */
export interface ChartStorageBackend {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    /** Every key held, so the chart can enumerate what it has stored. */
    keys(): string[];
}

let backend: ChartStorageBackend | null = null;

/**
 * Replace localStorage as the chart's backing store, or pass `null` to go back
 * to it.
 *
 * Anything already stored on this device that the backend doesn't have is copied
 * across, so switching over carries the user's settings with it instead of
 * resetting them. Install it before constructing a chart - the constructor reads
 * settings on the way up.
 */
export function setChartStorageBackend(next: ChartStorageBackend | null): void {
    backend = next;
    if (next) adoptLocalKeys(next);
    emitStorageChange();
}

function adoptLocalKeys(next: ChartStorageBackend): void {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
    try {
        const held = new Set(next.keys());
        for (const key of Object.keys(window.localStorage)) {
            if (!key.startsWith(STORAGE_NAMESPACE) || held.has(key)) continue;
            const value = window.localStorage.getItem(key);
            if (value !== null) next.setItem(key, value);
        }
    } catch {
        /* inaccessible storage - nothing to carry over */
    }
}

const localBackend: ChartStorageBackend = {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
    keys: () => Object.keys(window.localStorage),
};

// the active store, or null when there is nowhere to persist at all
function store(): ChartStorageBackend | null {
    if (backend) return backend;
    return hasStorage() ? localBackend : null;
}

/**
 * Whether the active store may be touched.
 *
 * The persistence preference means "don't write chart settings to this device",
 * so it only governs the default localStorage store. A host that installed a
 * backend of its own is persisting somewhere else entirely - an account, a
 * server - and how that is consented to is the host's business, not ours.
 */
function storeWritable(): ChartStorageBackend | null {
    const active = store();
    if (!active) return null;
    if (active === localBackend && !isPersistenceEnabled()) return null;
    return active;
}

let persistenceEnabled: boolean | null = null;
const persistenceListeners = new Set<(enabled: boolean) => void>();

/**
 * Fired when stored values are replaced wholesale - a save document is restored,
 * or everything is cleared. Individual writes do NOT fire it: the component that
 * made the write already knows. Lets mount-time readers (favorites, swatches)
 * re-read instead of showing state from before the restore.
 */
const storageListeners = new Set<() => void>();

export function onChartStorageChange(fn: () => void): () => void {
    storageListeners.add(fn);
    return () => storageListeners.delete(fn);
}

function emitStorageChange(): void {
    storageListeners.forEach((fn) => fn());
}

function hasStorage(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/** Whether the chart may read/write localStorage. Defaults to on. */
export function isPersistenceEnabled(): boolean {
    if (persistenceEnabled !== null) return persistenceEnabled;
    if (!hasStorage()) return true;
    try {
        persistenceEnabled = window.localStorage.getItem(PERSISTENCE_KEY) !== 'false';
    } catch {
        persistenceEnabled = true;
    }
    return persistenceEnabled;
}

export function setPersistenceEnabled(enabled: boolean): void {
    persistenceEnabled = enabled;
    if (hasStorage()) {
        try {
            window.localStorage.setItem(PERSISTENCE_KEY, String(enabled));
            // Switching on commits whatever the session accumulated while off, so
            // what the user is looking at is what gets saved.
            if (enabled) {
                for (const [key, value] of memoryStore) {
                    window.localStorage.setItem(key, value);
                }
            }
        } catch {
            /* quota / private mode - the in-memory value still applies this session */
        }
    }
    persistenceListeners.forEach((fn) => fn(enabled));
}

/** Subscribe to persistence toggles. Returns an unsubscribe function. */
export function onPersistenceChange(fn: (enabled: boolean) => void): () => void {
    persistenceListeners.add(fn);
    return () => persistenceListeners.delete(fn);
}

// Legacy key migration
const LEGACY_KEYS: Record<string, string> = {
    'christtrade.l3-chart-settings': StorageKey.chartSettings,
    christrade_custom_tfs: StorageKey.customTimeframes,
    christrade_favorite_tfs: StorageKey.favoriteTimeframes,
    drawing_style_templates: StorageKey.drawingTemplates,
    'ct:drawing-favorites': StorageKey.drawingFavorites,
    'christtrade-color-picker-saved': StorageKey.colorSwatches,
};

const LEGACY_PLUGIN_PREFIX = 'ctc:plugin:';

let migrated = false;

/**
 * Rename pre-namespace keys in place. Runs once per page load, before the first
 * read. Renaming is not "saving", so it happens regardless of the persistence
 * preference - otherwise turning persistence back on would find nothing.
 */
function migrateLegacyKeys(): void {
    if (migrated) return;
    migrated = true;
    if (!hasStorage()) return;

    try {
        const ls = window.localStorage;

        for (const [from, to] of Object.entries(LEGACY_KEYS)) {
            const value = ls.getItem(from);
            if (value === null) continue;
            if (ls.getItem(to) === null) ls.setItem(to, value);
            ls.removeItem(from);
        }

        // `ctc:plugin:<id>` and `ctc:plugin:<id>:<key>` -> `christtrade:chart:plugin:…`
        const stale = Object.keys(ls).filter((k) => k.startsWith(LEGACY_PLUGIN_PREFIX));
        for (const from of stale) {
            const value = ls.getItem(from);
            if (value === null) continue;
            const to = `${STORAGE_NAMESPACE}plugin:${from.slice(LEGACY_PLUGIN_PREFIX.length)}`;
            if (ls.getItem(to) === null) ls.setItem(to, value);
            ls.removeItem(from);
        }
    } catch {
        /* corrupt or inaccessible storage - nothing to migrate */
    }
}

// Gated accessors
//  Every write is mirrored into an in-memory map that ignores the persistence
//  gate. With persistence on it's just a write-through cache; with it off it's
//  the only backing store, so the chart still behaves normally *within* a session
//  (a component reads back what it just wrote) while nothing touches the disk and
//  every reload starts from defaults. It also means serializeChartPreferences()
//  captures what the user is actually looking at rather than stale pre-disable data.

/** Raw read. Falls back to the session store; null when nothing is set. */
export function readStored(key: string): string | null {
    const active = storeWritable();
    if (active) {
        if (active === localBackend) migrateLegacyKeys();
        try {
            // the store stays authoritative so a write from another tab, or a
            // value synced in from another device, wins over what we cached
            const value = active.getItem(key);
            if (value !== null) return value;
        } catch {
            /* fall through to the session store */
        }
    }
    return memoryStore.get(key) ?? null;
}

/** JSON read with a fallback for missing or malformed values. */
export function readJSON<T>(key: string, fallback: T): T {
    const raw = readStored(key);
    if (raw === null) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

/** Raw write. Stays in memory for the session when persistence is off. */
export function writeStored(key: string, value: string): void {
    memoryStore.set(key, value);
    const active = storeWritable();
    if (!active) return;
    try {
        active.setItem(key, value);
    } catch {
        /* quota exceeded / private mode - the session store still has it */
    }
}

/** JSON write. Stays in memory for the session when persistence is off. */
export function writeJSON(key: string, value: unknown): void {
    try {
        writeStored(key, JSON.stringify(value));
    } catch {
        /* circular / non-serialisable value */
    }
}

/**
 * Delete a key. Runs even when persistence is off, so "forget this" always
 * means forget it.
 */
export function removeStored(key: string): void {
    memoryStore.delete(key);
    try {
        store()?.removeItem(key);
    } catch {
        /* ignore */
    }
}

/** Delete every key under `prefix`. Runs regardless of the persistence flag. */
export function removeStoredByPrefix(prefix: string): void {
    for (const key of [...memoryStore.keys()]) {
        if (key.startsWith(prefix)) memoryStore.delete(key);
    }
    const active = store();
    if (!active) return;
    try {
        active
            .keys()
            .filter((k) => k.startsWith(prefix))
            .forEach((k) => active.removeItem(k));
    } catch {
        /* ignore */
    }
}

/**
 * Every chart-owned key currently holding a value, across both backing stores.
 * Excludes the persistence preference itself.
 */
export function chartStorageKeys(): string[] {
    const keys = new Set<string>();
    const owned = (k: string) => k.startsWith(STORAGE_NAMESPACE) && !k.startsWith(META_PREFIX);
    for (const key of memoryStore.keys()) {
        if (owned(key)) keys.add(key);
    }
    const active = storeWritable();
    if (active) {
        try {
            active.keys().filter(owned).forEach((k) => keys.add(k));
        } catch {
            /* ignore */
        }
    }
    keys.delete(PERSISTENCE_KEY);
    return [...keys];
}

/**
 * Wipe all chart-owned data, including plugin storage and any un-migrated
 * legacy keys. The persistence preference itself survives.
 */
export function clearChartStorage(): void {
    // Meta keys survive: a cleared device should fall back to defaults, not re-run
    // one-shot migrations it has already done.
    const clearable = (k: string) =>
        (k.startsWith(STORAGE_NAMESPACE) && k !== PERSISTENCE_KEY && !k.startsWith(META_PREFIX)) ||
        k.startsWith(LEGACY_PLUGIN_PREFIX) ||
        k in LEGACY_KEYS;

    for (const key of [...memoryStore.keys()]) {
        if (clearable(key)) memoryStore.delete(key);
    }
    const active = store();
    if (active) {
        try {
            active
                .keys()
                .filter(clearable)
                .forEach((k) => active.removeItem(k));
        } catch {
            /* ignore */
        }
    }
    emitStorageChange();
}

/** Rough byte count of everything the chart currently has stored. */
export function chartStorageSize(): number {
    return chartStorageKeys().reduce(
        (sum, key) => sum + key.length + (readStored(key)?.length ?? 0),
        0,
    );
}

// Save-document round-trip
/**
 * Device-level chart preferences - custom and favorite timeframes, favorite
 * drawings, drawing style templates, saved color swatches, and every plugin's
 * settings and KV store.
 *
 * Keyed by full storage key so anything added to StorageKey later, or written by
 * a third-party plugin, rides along without extra plumbing. Values are the parsed
 * JSON rather than raw strings so a save document stays readable; every writer
 * goes through writeJSON, so that round-trips losslessly.
 *
 * Per-pane chart settings are NOT here - those already travel in
 * `ChartSaveState.charts[i].settings`.
 */
export type ChartPreferences = Record<string, unknown>;

/** Wrapper for values that aren't JSON, so restore can tell them from a JSON string. */
const RAW_TAG = '$raw';

/**
 * Keys that belong to the device rather than the session: which plugins the user
 * switched on here, where they dragged their panels to.
 *
 * Deliberately outside the save-document round-trip. A document is always a
 * little stale - hosts snapshot on a timer - so letting one write these back
 * would resurrect a plugin the user switched off seconds before a reload, and
 * put their panels wherever they were two saves ago.
 */
const DEVICE_LOCAL_KEYS = new Set<string>([StorageKey.pluginStartup, StorageKey.pluginPanels]);

export function serializeChartPreferences(): ChartPreferences {
    const out: ChartPreferences = {};
    for (const key of chartStorageKeys()) {
        if (DEVICE_LOCAL_KEYS.has(key)) continue;
        const raw = readStored(key);
        if (raw === null) continue;
        try {
            out[key] = JSON.parse(raw);
        } catch {
            // Not JSON - written through writeStored rather than writeJSON. Tag it
            // so restore doesn't re-encode it as a JSON string.
            out[key] = { [RAW_TAG]: raw };
        }
    }
    return out;
}

/**
 * Apply a saved preferences block. Writes go through the persistence gate, so
 * restoring with persistence off applies for the session without touching disk.
 *
 * Merges by default: keys absent from `prefs` keep their current value. Pass
 * `{ replace: true }` for an exact "make this device look like the save" restore.
 */
export function restoreChartPreferences(
    prefs: ChartPreferences | undefined,
    opts: { replace?: boolean } = {},
): void {
    if (!prefs) return;
    if (opts.replace) {
        for (const key of chartStorageKeys()) {
            if (!(key in prefs) && !DEVICE_LOCAL_KEYS.has(key)) removeStored(key);
        }
    }
    for (const [key, value] of Object.entries(prefs)) {
        // Ignore anything outside our namespace - a save document should never be
        // able to write arbitrary localStorage keys on the host page.
        if (!key.startsWith(STORAGE_NAMESPACE) || key === PERSISTENCE_KEY) continue;
        // and a document written by an older build may still carry these
        if (DEVICE_LOCAL_KEYS.has(key)) continue;
        const raw = (value as Record<string, unknown> | null)?.[RAW_TAG];
        if (typeof raw === 'string') writeStored(key, raw);
        else writeJSON(key, value);
    }
    emitStorageChange();
}
