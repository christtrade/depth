# Voice — comments, changelog, docs

This applies to prose written in this repo: code comments, JSDoc, CHANGELOG
entries, commit messages, docs. It does not change how you write or structure
code itself.

## The rule, in order

1. **Does this need a comment at all?** Default answer: no. Comments in this
   repo are for the author reading their own code back in a year, not for a
   stranger — and a year from now, one glance at where a thing is used will
   revive the memory a comment would have spelled out. If a declaration's name
   plus its usage site already tell the story, there is no comment to write.
2. If it does need one: say the "why" once, in as few words as it takes, then
   stop.
3. Keep the language simple. Use letters that are easy to reach with the hands on the keyboard
4. No links to other files ("see RUN_PROGRESS_BATCH in script.worker.ts" - none of that!)

There's docs for the charting library - THERE is where docs are supposed to be, not
in code yk? (exception for the public api, tooltips in the code editor for what a function does is good)

A comment earns its place only when it survives both gates: something a
reader genuinely could not recover from the code (a non-obvious constraint, a
tradeoff, an empirically-measured number, a "why not the obvious thing" that
isn't visible from the call sites) — not "what this map is for" when the map's
name and its two usages already say that.

**Public API is the exception.** Anything exported from `src/core/index.ts`
(and re-exports like `@christtrade/depth/script-runtime`) is read by someone
who has never seen this codebase and can't go look at a usage site — they only
have the doc comment. That surface still gets real documentation, in the terse
register described below. Private module state, helper functions, and
anything not reachable from `index.ts` gets the harsher bar above: usually
zero comments.

## What went wrong before

Comments in this repo have landed as small essays — each one intro'd,
justified, then justified again from a different angle, often for facts a
declaration's name and its call site already carry. This is all private
module state in `ScriptedPlugin.ts` — nothing here is exported — and it
actually shipped looking like this:

```ts
// Module-level: the indicator capability and the strategy capability both
// need the same range, or Results and Optimize disagree about what they
// measured.
const strategyRanges = new Map<string, StrategyRange>();

// Entries with a streamed run in flight, by entry id, holding the run's
// token. Only the strategy capability knows when a run is genuinely over, so
// it clears this - not when the last chunk is *sent*, which is seconds
// before the numbers change and would make "done" a lie.
const streamingEntries = new Map<string, number>();

/** The worker's last reported chunk-processing position, by entry id. */
const chunkProgress = new Map<string, { done: number; total: number }>();

// Bars per fetch when streaming past what the chart holds. Small enough to be
// a trivial allocation, large enough that five years of minutes is dozens of
// round trips, not thousands.
const STREAM_CHUNK_BARS = 20_000n;
```

Every one of those is smaller than round one's version, and every one is
still wrong — the fix wasn't fewer words, it was recognizing none of them
earned a comment at all. `chunkProgress`'s "comment" is just its type
signature in prose. `strategyRanges` and `streamingEntries` are private state
whose reason for being module-level is visible the moment you read where
they're set and cleared. `STREAM_CHUNK_BARS` is a chunk size; the two call
sites that consume it are one `grep` away and a `20_000n` speaks for itself.
Cut to what actually survives the test:

```ts
const strategyRanges = new Map<string, StrategyRange>();
const streamingEntries = new Map<string, number>();
const chunkProgress = new Map<string, { done: number; total: number }>();
const STREAM_CHUNK_BARS = 20_000n;
```

Nothing. That's the default outcome for private state — not a shorter
comment, no comment. If one of these had genuinely non-recoverable reasoning
behind it (an empirically-tuned number, a constraint from an external system),
*that* line keeps one short comment and the rest still get none.

## How to write the comment that does survive

- One clause of "why," not a paragraph. If you're on a second sentence, ask
  whether it's new information or the first sentence said a different way.
- State it and move on. Don't hedge ("this is deliberate because...",
  "worth noting that...") — just say the thing.
- Contractions are fine. Fragments are fine. Not every comment needs a verb.
- Concrete numbers beat vague claims — "221 MB before, 1.1 MB after," not
  "significantly less memory."
- It's fine to be blunt about a limitation instead of softening it: "there is
  no way to stream backwards from an open-ended start," not "please note this
  may not currently support streaming backwards in all cases."
- Don't explain the same constraint from two places (a summary line, then a
  paragraph re-deriving it). Pick the one that carries the "why" and cut the
  other.
- Reference points for the register this should land in:
  [depth/CHANGELOG.md](CHANGELOG.md) (the [0.12.25] entry down through
  [0.12.21] — terse, one clause of justification per bullet, dry asides kept
  short) and, further afield, the [Hyprland wiki](https://wiki.hypr.land/) —
  not for the swearing-adjacent bluntness, but for the instinct to say a
  thing once, plainly, and stop rather than dress it up.

## When editing existing bloat

If you're touching a file with an existing essay-comment, don't leave it —
cut it to size (or cut it entirely — see above) in the same pass, even if
it's not what you were asked to change. That's how the bloat got here in the
first place: nobody wanted to touch a comment they didn't write.
