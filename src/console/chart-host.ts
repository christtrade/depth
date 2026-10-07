import type { DepthChart } from '../core/DepthChart';
import { PRESET_TIMEFRAMES, loadCustomTimeframes, parseCustomTimeframe } from '../lib/timeframes';
import { Console } from './Console';
import { bookCommand } from './tools/book';
import { freeCommand } from './tools/free';
import { tapeCommand } from './tools/tape';
import { topCommand } from './tools/top';
import { traceTools } from './tools/trace';
import { netCommand, netRecorder } from './tools/net';
import { registerNetGraph } from './tools/netgraph';
import { triggerTools } from './tools/triggers';
import { profileCommand } from './tools/profile';
import { lookCommand } from './tools/look';

export function createChartConsole(chart: DepthChart): Console {
    let focused = 0;
    chart.on('chart:focused', ({ id }) => (focused = id));

    const con = new Console({
        on: (event, fn) => chart.on(event, fn),
        emit: (event, data) => chart.eventBus.emit(event, data),
        settings: () => chart.getChart(focused).settings,
        focusedCell: () => focused,
        playheadNs: () => chart.playback.time,
        status: () => ({
            symbol: chart.getSymbol(),
            timeframe: chart.getTimeframe(),
            chartType: chart.getChart(focused).settings.chartType,
            cell: focused,
            playing: chart.playback.playing,
            playheadNs: chart.playback.time,
            speed: chart.playback.speed,
            stepSize: chart.playback.stepSize,
            mode: chart.playback.mode,
            floorNs: chart.playback.floor,
            tool: chart.getActiveTool().name,
            plugins: chart.getPluginCatalog().length,
        }),
    });

    con.registerType('Timeframe', {
        parse: (label) => {
            const tf =
                [...PRESET_TIMEFRAMES, ...loadCustomTimeframes()].find((t) => t.label.toLowerCase() === label.toLowerCase()) ??
                parseCustomTimeframe(label);
            if (!tf) throw new Error(`"${label}" isn't a timeframe - try 5m, 1h, 213m`);
            if (!chart.isTimeframeAllowed(tf.label)) throw new Error(`${tf.label} isn't available on this plan`);
            return tf;
        },
        complete: () => [...PRESET_TIMEFRAMES, ...loadCustomTimeframes()].map((t) => t.label),
    });

    con.register(topCommand(chart));
    con.register(freeCommand(chart));
    con.register(bookCommand(chart));
    con.register(tapeCommand(chart));
    for (const c of traceTools(chart, con)) con.register(c);

    con.register(netCommand(netRecorder()));
    registerNetGraph(chart, con);
    for (const c of triggerTools(chart, con)) con.register(c);

    con.register(profileCommand(chart));
    con.register(lookCommand(chart));

    // what 'js' sees
    // getters to get the current values
    Object.defineProperties(con.scope, {
        chart: { value: chart, enumerable: true },
        bus: { value: chart.eventBus, enumerable: true },
        playback: { value: chart.playback, enumerable: true },
        account: { value: chart.account, enumerable: true },
        exec: { value: chart.executionEngine, enumerable: true },
        settings: { get: () => chart.getChart(focused).settings, enumerable: true },
        pane: { get: () => chart.getChart(focused), enumerable: true },
        data: { get: () => chart.getData(), enumerable: true },
        emit: { value: (event: string, payload?: unknown) => chart.eventBus.emit(event as never, payload as never), enumerable: true },
        on: { value: (event: string, fn: (d: unknown) => void) => chart.on(event as never, fn as never), enumerable: true },
    });

    return con;
}
