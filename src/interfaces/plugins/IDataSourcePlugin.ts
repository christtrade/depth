/**
 * Contract for plugins that provide a custom data source (adapter factory).
 * A data-source plugin creates an IDataAdapter on demand, enabling remote
 * or community-built data feeds to be loaded as plugins.
 *
 * Requires the 'data:write' permission.
 */

import type { ChartPlugin } from './IChartPlugin';
import type { IDataAdapter } from '../IDataAdapter';

export interface DataSourcePlugin extends ChartPlugin {
    type: 'data-source';

    /**
     * Factory called by the engine when the user selects a symbol served by
     * this plugin. Return a fully initialised IDataAdapter.
     *
     * @param symbol  The symbol string the user requested.
     * @param config  Arbitrary config passed from the plugin's settings schema.
     */
    createAdapter(symbol: string, config: unknown): IDataAdapter;
}
