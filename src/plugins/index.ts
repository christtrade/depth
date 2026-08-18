// the built-in indicators. every one is a scripted plugin in the same format a
// user writes in the editor, installed by DepthChart on construction.
//
// to add one: drop the script in this folder and add a row below. the category
// picks its group in the indicators picker and has to be a BuiltinCategory or it
// falls back to "Other" - a script can also declare its own category, which wins
// over the value here.
//
// keep the builtin: id prefix, the picker uses it to tell these from
// user-installed plugins.
import { alligatorIndi } from './alligator';
import { atrIndi } from './atr';
import { awesomeIndi } from './awesome-oscillator';
import { bbIndi } from './bollinger-bands';
import { cciIndi } from './cci';
import { cvdIndi } from './cvd';
import { donchianIndi } from './donchian';
import { ichimokuIndi } from './ichimoku';
import { keltnerIndi } from './keltner';
import { macdIndi } from './macd';
import { maIndi } from './moving-average';
import { mfiIndi } from './mfi';
import { obvIndi } from './obv';
import { psarIndi } from './psar';
import { rsiIndi } from './rsi';
import { sessionsIndi } from './sessions';
import { stochasticIndi } from './stochastic';
import { supertrendIndi } from './supertrend';
import { volumeIndi } from './volume';
import { vwapIndi } from './vwap';
import { williamsRIndi } from './williams-r';

/** [script, plugin id, picker category] */
export type BuiltinIndicatorEntry = readonly [code: string, id: string, category: string];

export const BUILTIN_INDICATORS: readonly BuiltinIndicatorEntry[] = [
    // trend
    [maIndi, 'builtin:moving-average', 'trend'],
    [supertrendIndi, 'builtin:supertrend', 'trend'],
    [ichimokuIndi, 'builtin:ichimoku', 'trend'],
    [psarIndi, 'builtin:psar', 'trend'],
    [vwapIndi, 'builtin:vwap', 'trend'],
    [alligatorIndi, 'builtin:alligator', 'trend'],

    // momentum
    [rsiIndi, 'builtin:rsi', 'momentum'],
    [macdIndi, 'builtin:macd', 'momentum'],
    [stochasticIndi, 'builtin:stochastic', 'momentum'],
    [cciIndi, 'builtin:cci', 'momentum'],
    [williamsRIndi, 'builtin:williams-r', 'momentum'],
    [awesomeIndi, 'builtin:awesome-oscillator', 'momentum'],

    // volatility
    [bbIndi, 'builtin:bollinger-bands', 'volatility'],
    [keltnerIndi, 'builtin:keltner', 'volatility'],
    [donchianIndi, 'builtin:donchian', 'volatility'],
    [atrIndi, 'builtin:atr', 'volatility'],

    // volume
    [volumeIndi, 'builtin:volume', 'volume'],
    [obvIndi, 'builtin:obv', 'volume'],
    [mfiIndi, 'builtin:mfi', 'volume'],

    // // order flow
    // [cvdIndi, 'builtin:cvd', 'orderflow'],

    // other
    [sessionsIndi, 'builtin:sessions', 'other'],
] as const;

export {
    alligatorIndi,
    atrIndi,
    awesomeIndi,
    bbIndi,
    cciIndi,
    cvdIndi,
    donchianIndi,
    ichimokuIndi,
    keltnerIndi,
    macdIndi,
    maIndi,
    mfiIndi,
    obvIndi,
    psarIndi,
    rsiIndi,
    sessionsIndi,
    stochasticIndi,
    supertrendIndi,
    volumeIndi,
    vwapIndi,
    williamsRIndi,
};
