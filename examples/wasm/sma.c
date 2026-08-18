// A Depth wasm plugin: a simple moving average over the close. Build it with
//
//   clang --target=wasm32 -nostdlib -O2 -Wl,--no-entry -o sma.wasm sma.c
//
// The whole ABI is in src/docs/plugin-wasm.txt. The short version: the host writes
// rows of doubles into our memory, calls init/update, and reads back a block of
// doubles we hand back. Nothing else crosses the boundary.

#define BAR_STRIDE 6
#define BAR_CLOSE 4
#define MAX_BARS 500000

#define EXPORT(name) __attribute__((export_name(name)))

// the host prints whatever we pass here, which is the only way out of the
// sandbox besides the return value
__attribute__((import_module("env"), import_name("log"))) extern void host_log(const char *ptr,
                                                                               int len);

// 8MB of scratch, handed out by a bump pointer. A real allocator is allowed -
// the host always pairs alloc with dealloc - but a chart recomputes from
// scratch often enough that resetting on init is simpler and faster.
static __attribute__((aligned(8))) char heap[8 << 20];
static int heap_used = 0;

EXPORT("alloc") int wasm_alloc(int bytes) {
    int offset = (heap_used + 7) & ~7; // 8-aligned, the host writes doubles
    if (offset + bytes > (int)sizeof(heap)) return 0;
    heap_used = offset + bytes;
    return (int)(long)(heap + offset);
}

EXPORT("dealloc") void wasm_dealloc(int ptr, int bytes) {
    // a bump allocator can only give back the block it handed out last, and
    // init resets the whole thing anyway
    (void)ptr;
    (void)bytes;
}

// The one param we take. Parsing real JSON in C isn't worth it for a single
// number, so we scan for the key and read the digits after it.
static int period = 20;

EXPORT("set_params") void wasm_set_params(int ptr, int len) {
    const char *json = (const char *)(long)ptr;
    const char *key = "\"period\":";
    period = 20;
    for (int i = 0; i + 9 <= len; i++) {
        int match = 1;
        for (int k = 0; k < 9; k++)
            if (json[i + k] != key[k]) match = 0;
        if (!match) continue;
        int j = i + 9, value = 0, digits = 0;
        while (j < len && json[j] == ' ') j++;
        while (j < len && json[j] >= '0' && json[j] <= '9') value = value * 10 + (json[j++] - '0'), digits++;
        if (digits) period = value;
        break;
    }
    if (period < 1) period = 1;
}

// Rolling state. Kept between calls so update() never rescans history.
static double closes[MAX_BARS];
static double sma[MAX_BARS];
static double timestamps[MAX_BARS];
static int len = 0;
static double window_sum = 0;

// the result block the host reads: an i32 count, 4 bytes of padding so the
// doubles land 8-aligned, then that many doubles. two per bar here - the values
// and then their timestamps - so the buffer is sized for both
static __attribute__((aligned(8))) char result[8 + MAX_BARS * 2 * 8];

// two doubles per bar, interleaved - the value and the timestamp it belongs to.
// interleaved and not two half-blocks, because update() hands back only the new
// rows and the host concatenates them onto the ones it already has: halves would
// stop lining up on the first tick.
static int emit(const double *values, int count) {
    int start = len - count;              // first bar in this batch
    *(int *)result = count * 2;
    double *out = (double *)(result + 8);
    for (int i = 0; i < count; i++) {
        out[i * 2] = values[i];
        out[i * 2 + 1] = timestamps[start + i];
    }
    return (int)(long)result;
}

static void push(double close, double ts) {
    if (len >= MAX_BARS) return;
    closes[len] = close;
    timestamps[len] = ts;
    window_sum += close;
    if (len >= period) window_sum -= closes[len - period];
    // NaN until the window is full - the chart leaves gaps for it
    sma[len] = len + 1 < period ? __builtin_nan("") : window_sum / period;
    len++;
}

EXPORT("init")
int wasm_init(int bars_ptr, int bar_rows, int trades_ptr, int trade_rows, double bar_ms) {
    (void)trades_ptr;
    (void)trade_rows;
    (void)bar_ms;

    heap_used = 0;
    len = 0;
    window_sum = 0;

    const double *bars = (const double *)(long)bars_ptr;
    for (int i = 0; i < bar_rows; i++) push(bars[i * BAR_STRIDE + BAR_CLOSE], bars[i * BAR_STRIDE + 0]);

    return emit(sma, len);
}

EXPORT("update")
int wasm_update(int bars_ptr, int bar_rows, int trades_ptr, int trade_rows, double bar_ms) {
    (void)trades_ptr;
    (void)trade_rows;
    (void)bar_ms;

    const double *bars = (const double *)(long)bars_ptr;
    int before = len;
    for (int i = 0; i < bar_rows; i++) push(bars[i * BAR_STRIDE + BAR_CLOSE], bars[i * BAR_STRIDE + 0]);

    // only what this call produced - the host appends it to what it already has
    return emit(sma + before, len - before);
}
