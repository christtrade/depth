//  Global constants for the visualiser
// Minimum trade size to plot - filters out tiny noise trades
// Set to 1 to plot everything, raise it to focus on meaningful trades
export const MIN_TRADE_SIZE = 1;

// How large a dot can get at maximum (pixels)
export const MAX_DOT_RADIUS = 8;

// How small a dot can get at minimum (pixels)
export const MIN_DOT_RADIUS = 1.5;

export const MIN_TIME_SPAN = 10_000_000n; // ~10ms in nanoseconds
export const MAX_TIME_SPAN = 86_400_000_000_000n; // 24 hours - absolute ceiling
