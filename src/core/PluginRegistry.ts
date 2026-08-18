import { DataLevel } from '../interfaces/IDataAdapter';
import { RenderEngine } from './RenderEngine';
import { TypedEventBus } from './TypedEventBus';
import { isCompatible } from './processing/data-level';

// svg path descriptor for a custom icon
export interface PluginIcon {
    viewBox: string;
    paths: string[];
}

// re-exported plugin API types, defined in interfaces/plugins
export type {
    PluginType,
    Permission,
    ToolbarItem,
    BottomBarItem,
    BottomBarHandle,
    FloatingPanelOpts,
    ContextMenuItem,
    ThemeDef,
    SettingSchema,
    SettingSchemaType,
    PluginStorage,
    ServiceApi,
    ServiceObserver,
    PluginServices,
    PluginSchedule,
    NotifyLevel,
    NotifyOptions,
    PluginStateSnapshot,
    PluginExecutionSurface,
    PluginLifecycle,
    PaneOptions,
    PluginDataSnapshot,
    PluginContext,
    ChartPlugin,
    PluginManifest,
} from '../interfaces/plugins/IChartPlugin';

export type { DrawingPlugin } from '../interfaces/plugins/IDrawingPlugin';

export type {
    ChartTypePlugin,
    ChartTypeRenderContext,
    ChartTypeActiveContext,
    ChartTypePointerEvent,
    ChartTypeKeyEvent,
} from '../interfaces/plugins/IChartTypePlugin';

export type { DataSourcePlugin } from '../interfaces/plugins/IDataSourcePlugin';
export type { IndicatorPlugin } from '../interfaces/plugins/IIndicatorPlugin';

import type {
    ChartPlugin,
    PluginContext,
    Permission,
    ServiceApi,
    ServiceObserver,
    PluginLifecycle,
    PluginServices,
} from '../interfaces/plugins/IChartPlugin';

/**
 * A pooled plugin as persisted in a save document. The id is kept so a restore
 * re-installs under the same one, and a host that also installs the plugin
 * manually dedups against the restored copy rather than accumulating duplicates.
 */
export interface InstalledPlugin {
    id: string;
    code: string;
}

export class PluginRegistry {
    private installed = new Map<
        string,
        { plugin: ChartPlugin; ctx: PluginContext; teardown: () => void }
    >();
    private readonly serviceRegistry = new Map<string, ServiceApi>();
    private readonly serviceListeners = new Map<string, Set<any>>();

    private pendingInstalls: Array<{ plugin: ChartPlugin; ctx: PluginContext }> = [];
    private renderEngineReady = false;
    private eventBus: TypedEventBus | null = null;


    public options = {
        enabled: true,
        indicator: true,
        drawing: true,
        'chart-type': true,
        extension: true,
    };

    setOptions(options: {
        enabled: boolean;
        indicators: boolean;
        drawings: boolean;
        charts: boolean;
        extensions: boolean;
    }) {
        const map = {
            indicators: 'indicator',
            drawings: 'drawing',
            charts: 'chart-type',
            extensions: 'extension',
            enabled: 'enabled',
        };
        for (const key in options) {
            this.options[map[key]] = options[key];
        }
    }

    // so the registry can emit lifecycle events. DepthChart calls this itself.
    setEventBus(bus: TypedEventBus): void {
        this.eventBus = bus;
    }

    /**
     * Is this id installed, or queued for install? Install is async - a plugin
     * registered before the RenderEngine attaches sits in pendingInstalls, and
     * callers have to treat that as installed or they double-install it.
     */
    has(id: string): boolean {
        return this.installed.has(id) || this.pendingInstalls.some((p) => p.plugin.id === id);
    }

    /** Ids of every installed / pending plugin. */
    getInstalledIds(): string[] {
        return [...this.installed.keys(), ...this.pendingInstalls.map((p) => p.plugin.id)];
    }

    /** Name and type of every installed / pending plugin, for a manager UI. */
    getInstalledPlugins(): Array<{ id: string; name: string; type: ChartPlugin['type'] }> {
        const of = (p: ChartPlugin) => ({ id: p.id, name: p.name ?? p.id, type: p.type });
        return [
            ...[...this.installed.values()].map((e) => of(e.plugin)),
            ...this.pendingInstalls.map((e) => of(e.plugin)),
        ];
    }

    async register(plugin: ChartPlugin, ctx: PluginContext): Promise<void> {
        if (!this.options?.enabled || !this.options[plugin.type]) return;

        if (this.installed.has(plugin.id)) {
            console.warn(`[PluginRegistry] '${plugin.id}' already installed - skipping`);
            return;
        }

        if (!this.renderEngineReady) {
            this.pendingInstalls.push({ plugin, ctx });
            return;
        }

        await this._doInstall(plugin, ctx);
    }

    notifyRenderEngineReady(engine: RenderEngine): void {
        this.renderEngineReady = true;

        if (this.pendingInstalls.length === 0) return;


        const queue = this.pendingInstalls.splice(0);
        for (const { plugin, ctx } of queue) {
            this._doInstall(plugin, ctx).catch((err) => {
                console.error(`[PluginRegistry] Deferred install of '${plugin.id}' failed:`, err);
            });
        }
    }

    buildLifecycle(eventBus: TypedEventBus): PluginLifecycle {
        return {
            onSymbolChange(cb) {
                return eventBus.on('chart:set-symbol', ({ symbol }) => cb(symbol));
            },
            onTimeframeChange(cb) {
                return eventBus.on('chart:set-timeframe', ({ tf }) => cb(tf as any));
            },
            onThemeChange(cb) {
                return eventBus.on('theme:change' as any, (theme: any) => cb(theme));
            },
            onFocus(cb) {
                return eventBus.on('chart:focused', ({ id }) => cb(id));
            },
            onBlur(cb) {
                return eventBus.on('chart:blurred' as any, cb);
            },
        };
    }

    private async _doInstall(plugin: ChartPlugin, ctx: PluginContext): Promise<void> {
        // data level compatibility
        const required: DataLevel = plugin.require ?? 'ohlcv';
        const actual: DataLevel = ctx.dataLevel;
        const permissionContext = this.buildRestrictedContext(
            ctx,
            () => plugin.permissions ?? [],
            plugin.id,
            () => plugin.origins ?? [],
        );

        if (!isCompatible(required, actual)) {
            console.warn(
                `[PluginRegistry] Plugin '${plugin.id}' requires '${required}' but chart has '${actual}' - skipping`,
            );
            this.eventBus?.emit('plugin:incompatible', {
                id: plugin.id,
                name: plugin.name,
                kind: 'plugin',
                required,
                actual,
            });
            return;
        }

        try {
            const result = await plugin.install(permissionContext);
            const teardown: () => void = typeof result === 'function' ? result : () => {};
            this.installed.set(plugin.id, { plugin, ctx: permissionContext, teardown });
            this.eventBus?.emit('plugin:installed', { id: plugin.id });
        } catch (err) {
            console.error(`[PluginRegistry] install() threw for '${plugin.id}':`, err);
        }
    }

    buildServices(pluginId: string): PluginServices {
        return {
            register: <T extends ServiceApi>(name: string, api: T): (() => void) => {
                if (this.serviceRegistry.has(name)) {
                    console.warn(`[PluginServices] '${name}' already registered - overwriting`);
                }
                this.serviceRegistry.set(name, api);
                this.serviceListeners.get(name)?.forEach((obs: any) => obs.onAvailable(api));
                return () => {
                    if (this.serviceRegistry.get(name) === api) {
                        this.serviceRegistry.delete(name);
                        this.serviceListeners.get(name)?.forEach((obs: any) => obs.onRemoved?.());
                    }
                };
            },
            get: <T extends ServiceApi>(name: string): T | null => {
                return (this.serviceRegistry.get(name) as T) ?? null;
            },
            on: <T extends ServiceApi>(
                name: string,
                observer: ServiceObserver<T>,
            ): (() => void) => {
                const existing = this.serviceRegistry.get(name);
                if (existing) observer.onAvailable(existing as T);
                if (!this.serviceListeners.has(name)) this.serviceListeners.set(name, new Set());
                this.serviceListeners.get(name)!.add(observer);
                return () => this.serviceListeners.get(name)?.delete(observer);
            },
        };
    }

    private buildRestrictedContext(
        ctx: PluginContext,
        getPermissions: () => Permission[],
        pluginId: string,
        getOrigins: () => string[],
    ): PluginContext {
        const has = (p: Permission) => getPermissions().includes(p);
        const gate =
            (perm: Permission, fn: Function) =>
            (...args: any[]) => {
                if (!has(perm)) throw new Error(`Missing ${perm}`);
                return fn(...args);
            };

        // the network permission says a plugin may make requests at all; origins
        // says where to. a plugin holding someone's api key is only trustworthy
        // if it cant post that key somewhere else.
        //
        // async, not gate()d: this is fetch, so a caller is entitled to see a
        // refusal as a rejection rather than something that skips their .catch
        const fetchWithinOrigins = async (url: string, init?: RequestInit): Promise<Response> => {
            if (!has('network')) throw new Error('Missing network');

            let target: string;
            try {
                target = new URL(url, globalThis.location?.href).origin;
            } catch {
                throw new Error(`[Plugin "${pluginId}"] fetch called with a bad url: ${url}`);
            }

            const allowed = getOrigins().some((entry) => {
                try {
                    return new URL(entry).origin === target;
                } catch {
                    return false; // a junk entry allows nothing, it doesnt break the rest
                }
            });
            if (!allowed) {
                throw new Error(
                    `[Plugin "${pluginId}"] fetch to ${target} is not allowed. ` +
                        `Add it to the plugin's origins to reach it.`,
                );
            }
            return ctx.fetch(url, init);
        };
        return {
            ...ctx,
            registerPane: ctx.registerPane,

            get renderEngine() {
                return has('render:overlay') ? ctx.renderEngine : (null as any);
            },

            getData: gate('data:read', ctx.getData) as typeof ctx.getData,
            openBar: gate('data:read', ctx.openBar) as typeof ctx.openBar,
            registerPanel: gate('ui:panel', ctx.registerPanel) as typeof ctx.registerPanel,
            registerToolbarItem: gate(
                'ui:toolbar',
                ctx.registerToolbarItem,
            ) as typeof ctx.registerToolbarItem,
            registerBottomBarItem: gate(
                'ui:toolbar',
                ctx.registerBottomBarItem,
            ) as typeof ctx.registerBottomBarItem,
            registerContextMenuItem: gate(
                'ui:context-menu',
                ctx.registerContextMenuItem,
            ) as typeof ctx.registerContextMenuItem,
            registerDrawingTool: gate(
                'drawing:register',
                ctx.registerDrawingTool,
            ) as typeof ctx.registerDrawingTool,
            registerTheme: gate('theme:register', ctx.registerTheme) as typeof ctx.registerTheme,
            playSound: gate('audio', ctx.playSound) as typeof ctx.playSound,
            fetch: fetchWithinOrigins as typeof ctx.fetch,
            intercept: gate('intercept', ctx.intercept) as typeof ctx.intercept,
            addOverlay: gate('render:overlay', ctx.addOverlay) as typeof ctx.addOverlay,
            registerDataSource: gate(
                'data:write',
                ctx.registerDataSource,
            ) as typeof ctx.registerDataSource,

            get storage() {
                if (!has('storage')) throw new Error('Missing storage');
                return ctx.storage;
            },

            services: ctx.services,
            lifecycle: ctx.lifecycle,
            schedule: ctx.schedule,
            notify: ctx.notify,
            playback: ctx.playback,

            get execution() {
                if (has('execution:write')) return ctx.execution;
                if (has('execution:read')) {
                    return ctx.execution
                        ? {
                              ...ctx.execution,
                              placeOrder: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                              cancelOrder: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                              amendOrder: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                              amendBracket: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                              closePosition: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                              reversePosition: () => {
                                  throw new Error(`Plugin '${pluginId}' missing execution:write`);
                              },
                          }
                        : null;
                }
                return null;
            },
        };
    }

    serialize(): InstalledPlugin[] {
        return [...this.installed.entries()]
            .filter(
                ([id, entry]) => !id.startsWith('builtin') && typeof entry.plugin.code === 'string',
            )
            .map(([id, entry]) => ({ id, code: entry.plugin.code as string }));
    }

    unregister(id: string): void {
        const entry = this.installed.get(id);
        if (!entry) {
            const idx = this.pendingInstalls.findIndex((p) => p.plugin.id === id);
            if (idx !== -1) {
                this.pendingInstalls.splice(idx, 1);
                this.eventBus?.emit('plugin:uninstalled', { id });
            }
            return;
        }
        try {
            entry.teardown();
            entry.plugin.uninstall?.(entry.ctx);
        } catch (err) {
            console.warn(`[PluginRegistry] teardown error for '${id}':`, err);
        }
        this.installed.delete(id);
        // announce after teardown, so listeners dropping the plugin's indicators
        // and defs run against a registry that no longer holds it
        this.eventBus?.emit('plugin:uninstalled', { id });
    }

    destroy(): void {
        for (const [, entry] of this.installed) {
            try {
                entry.teardown();
                entry.plugin.uninstall?.(entry.ctx);
            } catch {}
        }
        this.installed.clear();
        this.pendingInstalls = [];
        this.renderEngineReady = false;
    }
}
