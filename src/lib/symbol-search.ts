/**
 * The built-in symbol matcher. Used by DataEngine whenever the adapter declares
 * `symbolSearch: 'none'` (the default) - the adapter hands over its universe
 * once and every keystroke is matched here instead of over the network.
 *
 * Adapters that search server-side can still import this to match and rank their
 * own results the same way the built-in picker does.
 *
 * Matching is word-anchored, never substring-anywhere. That distinction is the
 * whole design: a universe of "Spot X / TetherUS" pairs has "eth" sitting inside
 * "t-eth-er" on every single row, so a loose substring rule returns the entire
 * list for the first three characters of "ethusdt". Queries match the start of a
 * word, the start of the ticker, or as a fuzzy subsequence of the ticker - and
 * nothing else.
 */

import type {
    SymbolInfo,
    SymbolSearchRequest,
    SymbolSearchResponse,
} from '../interfaces/IDataAdapter';

/** Ranking tiers, best first. Ties keep the adapter's own ordering. */
const Rank = {
    /** Query is the ticker. */
    ExactSymbol: 0,
    /** Whole query starts the ticker: "btc" -> btcusdt. */
    SymbolPrefix: 1,
    /** A token starts the ticker. */
    TokenSymbolPrefix: 2,
    /** A token starts a word of the name or a keyword: "ethereum" -> Spot Ethereum. */
    WordPrefix: 3,
    /** A token appears inside the ticker: "usdt" -> btcusdt. */
    SymbolSubstring: 4,
    /** A token starts a word of the exchange. */
    Exchange: 5,
    /** A token's characters appear in order: "ehusdt" -> ethusdt. */
    Fuzzy: 6,
    NoMatch: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * A subsymbol match ranks just below the same match on a parent, so /NQ1 still
 * outranks the individual contract that happens to share the query.
 */
const SUBSYMBOL_PENALTY = 0.5;

/** Below this length, prefix and substring rules already cover it - fuzz adds only noise. */
const FUZZY_MIN_LENGTH = 3;

/**
 * How far a fuzzy match may spread. "btcst" over btcusdt spans 7 for 5 chars
 * (1.4x) and is clearly intended; letters scattered across a long ticker are not.
 */
const FUZZY_MAX_SPAN_RATIO = 2;

/** Splits on anything that isn't a letter or digit. */
const NON_WORD = /[^a-z0-9]+/;

/** The searchable words of one symbol, built once and reused across keystrokes. */
interface Haystack {
    symbol: string;
    /** Name and keyword words. */
    words: string[];
    exchangeWords: string[];
}

const haystacks = new WeakMap<SymbolInfo, Haystack>();

/**
 * Split text into matchable words, breaking on punctuation and camelCase.
 * "Spot Ethereum / TetherUS" -> spot, ethereum, tetherus, tether, us - so "tether"
 * matches the pair it names while "eth" does not.
 */
function tokenizeText(text: string): string[] {
    if (!text) return [];
    const camelSplit = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const words = [
        ...text.toLowerCase().split(NON_WORD),
        ...camelSplit.toLowerCase().split(NON_WORD),
    ];
    return words.filter(Boolean);
}

function haystackFor(s: SymbolInfo): Haystack {
    const cached = haystacks.get(s);
    if (cached) return cached;

    const words = new Set<string>();
    for (const text of [s.longName ?? '', s.description ?? '', ...(s.keywords ?? [])]) {
        for (const w of tokenizeText(text)) words.add(w);
    }

    const exchangeWords = new Set<string>();
    for (const text of [s.exchange ?? '', s.listedExchange ?? '']) {
        for (const w of tokenizeText(text)) exchangeWords.add(w);
    }

    const built: Haystack = {
        symbol: s.symbol.toLowerCase(),
        words: [...words],
        exchangeWords: [...exchangeWords],
    };
    haystacks.set(s, built);
    return built;
}

/**
 * Length of the window containing `q`'s characters in order within `text`,
 * or -1 when they don't all appear. A tight span means a deliberate abbreviation.
 */
function subsequenceSpan(text: string, q: string): number {
    let from = 0;
    let start = -1;
    for (const ch of q) {
        const at = text.indexOf(ch, from);
        if (at === -1) return -1;
        if (start === -1) start = at;
        from = at + 1;
    }
    return from - start;
}

function fuzzyMatches(text: string, token: string): boolean {
    if (token.length < FUZZY_MIN_LENGTH) return false;
    // Anchored to the first character. Unanchored subsequences re-create the very
    // problem word-matching solves: "eth" is a subsequence of "t-e-th-er", so
    // every Tether pair would come back for the first three letters of "ethusdt".
    if (text[0] !== token[0]) return false;
    const span = subsequenceSpan(text, token);
    return span !== -1 && span <= token.length * FUZZY_MAX_SPAN_RATIO;
}

/** Best tier one query token reaches against one symbol. */
function scoreToken(h: Haystack, token: string): number {
    if (h.symbol.startsWith(token)) return Rank.TokenSymbolPrefix;

    for (const w of h.words) if (w.startsWith(token)) return Rank.WordPrefix;

    if (h.symbol.includes(token)) return Rank.SymbolSubstring;

    for (const w of h.exchangeWords) if (w.startsWith(token)) return Rank.Exchange;

    if (fuzzyMatches(h.symbol, token)) return Rank.Fuzzy;
    for (const w of h.words) if (fuzzyMatches(w, token)) return Rank.Fuzzy;

    return Rank.NoMatch;
}

/**
 * Lower is better; `Rank.NoMatch` drops the symbol. Every token of a multi-word
 * query must land somewhere - "digital gold" only matches a symbol carrying both.
 */
function scoreSymbol(s: SymbolInfo, tokens: string[], query: string): number {
    const h = haystackFor(s);

    if (h.symbol === query) return Rank.ExactSymbol;
    if (h.symbol.startsWith(query)) return Rank.SymbolPrefix;

    let worst = 0;
    for (const token of tokens) {
        const tier = scoreToken(h, token);
        if (tier >= Rank.NoMatch) return Rank.NoMatch;
        worst = Math.max(worst, tier);
    }
    return worst;
}

function passesFacets(s: SymbolInfo, request: SymbolSearchRequest): boolean {
    if (request.type && s.type !== request.type) return false;
    if (request.dataLevel && s.dataLevel !== request.dataLevel) return false;
    if (request.exchange) {
        const wanted = request.exchange.toLowerCase();
        const matches =
            s.exchange?.toLowerCase() === wanted || s.listedExchange?.toLowerCase() === wanted;
        if (!matches) return false;
    }
    return true;
}

/**
 * Match, rank and page `symbols` against `request`. Non-matching symbols are
 * dropped, not merely sorted down.
 *
 * A parent survives if it or any of its subsymbols matches, so a group stays
 * reachable while searching for one of its contracts. Subsymbols are never
 * hoisted into the result - the picker renders them nested under their parent.
 */
export function searchSymbolsLocally(
    symbols: SymbolInfo[],
    request: SymbolSearchRequest,
): SymbolSearchResponse {
    const query = request.query.trim().toLowerCase();
    const tokens = query.split(NON_WORD).filter(Boolean);

    const hits: Array<{ symbol: SymbolInfo; rank: number; index: number }> = [];

    symbols.forEach((s, index) => {
        const subs = s.subsymbols ?? [];
        if (!passesFacets(s, request) && !subs.some((sub) => passesFacets(sub, request))) return;

        let rank = Rank.ExactSymbol as number;
        if (tokens.length) {
            rank = scoreSymbol(s, tokens, query);
            for (const sub of subs) {
                rank = Math.min(rank, scoreSymbol(sub, tokens, query) + SUBSYMBOL_PENALTY);
            }
            if (rank >= Rank.NoMatch) return;
        }

        hits.push({ symbol: s, rank, index });
    });

    hits.sort((a, b) => a.rank - b.rank || a.index - b.index);

    const offset = request.cursor ? Number(request.cursor) || 0 : 0;
    const limit = request.limit && request.limit > 0 ? request.limit : hits.length;
    const page = hits.slice(offset, offset + limit);
    const end = offset + page.length;
    const hasMore = end < hits.length;

    return {
        symbols: page.map((h) => h.symbol),
        hasMore,
        cursor: hasMore ? String(end) : undefined,
    };
}

/** Adapters may return a bare array for convenience. Normalize to a response. */
export function normalizeSymbolSearchResponse(
    result: SymbolSearchResponse | SymbolInfo[],
): SymbolSearchResponse {
    return Array.isArray(result) ? { symbols: result, hasMore: false } : result;
}

/** Cache key for a search. Ignores `signal`, which never affects the result. */
export function symbolSearchCacheKey(request: SymbolSearchRequest): string {
    return JSON.stringify([
        request.query.trim().toLowerCase(),
        request.type ?? '',
        request.exchange ?? '',
        request.dataLevel ?? '',
        request.limit ?? 0,
        request.cursor ?? '',
    ]);
}
