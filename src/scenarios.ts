// A faithful simulation of the diagnostics_channel tracing-channel lifecycle.
// Event orders are the ones we verified empirically on Node 20-26.
//
// Each scenario is a list of ordered "frames" (steps). A frame records:
//   depth    -> indentation, to read like a call stack
//   kind     -> setup | call | run | transform | event | op
//   channel  -> for event frames: start | end | asyncStart | asyncEnd | error | publish
//   store    -> the active AsyncLocalStorage value now: request | span | none
//   ctx      -> the shared tracing-channel context object at this point (inspectable)
//   trace    -> the resulting span tree at this point (the waterfall)
//   hl       -> code line indices to highlight
//   caption  -> one-line "why" shown under the store banner
//   tone     -> visual accent

export type StoreKey = 'request' | 'span' | 'none';
export type Channel = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error' | 'publish';
export type Kind = 'setup' | 'call' | 'run' | 'transform' | 'event' | 'op';
export type Tone = 'muted' | 'normal' | 'good' | 'warn' | 'bad' | 'event';

export type Ctx = Record<string, unknown>;

export type SpanState = 'open' | 'closed' | 'orphan';
export type SpanTone = 'root' | 'span' | 'child' | 'warn' | 'bad';
export interface SpanNode {
  name: string;
  depth: number;
  state: SpanState;
  tone: SpanTone;
  active: boolean;
}

export interface Step {
  depth: number;
  kind: Kind;
  channel?: Channel;
  title: string;
  detail: string;
  caption?: string;
  hl: number[];
  store: StoreKey;
  ctx: Ctx | null;
  trace: SpanNode[];
  tone: Tone;
}

export interface VariantOption {
  value: string;
  label: string;
}
export interface Variant {
  key: string;
  label: string;
  options: VariantOption[];
}

export type VState = Record<string, string>;

export interface Scenario {
  id: string;
  label: string;
  blurb: string;
  variants: Variant[];
  code: (state: VState) => string[];
  build: (state: VState) => Step[];
}

const SQL = 'SELECT * FROM orders';

const ctxBase = (): Ctx => ({ arguments: [SQL] });
const ctxTransformed = (): Ctx => ({
  arguments: [SQL],
  _sentryCallerStore: '⟨ request scope ⟩',
  _sentrySpan: '⟨ span: db.query ⟩',
});
const ctxResult = (): Ctx => ({ ...ctxTransformed(), result: 'OkPacket { affectedRows: 12 }' });
const ctxError = (): Ctx => ({ ...ctxTransformed(), error: 'Error: ER_PARSE_ERROR' });

// ---- span tree snapshots (the waterfall) ----
const reqN = (active: boolean): SpanNode => ({ name: 'GET /orders', depth: 0, state: 'open', tone: 'root', active });
const qN = (state: SpanState, active: boolean): SpanNode => ({ name: 'db.query', depth: 1, state, tone: 'span', active });
const childN = (
  depth: number, tone: SpanTone, name: string, active = true, state: SpanState = 'open',
): SpanNode => ({ name, depth, state, tone, active });

const tBefore = (): SpanNode[] => [reqN(true)];
const tSpan = (): SpanNode[] => [reqN(false), qN('open', true)];
const tSpanReq = (): SpanNode[] => [reqN(true), qN('open', false)];
const tDone = (): SpanNode[] => [reqN(true), qN('closed', false)];

// Shared wiring shown at the top of most scenarios' code (lines 0-8).
const WIRE: string[] = [
  'const { als, getStoreWithActiveSpan } =',
  '  getAsyncContextStrategy().getTracingChannelBinding()',
  '',
  'channel.start.bindStore(als, data => {',
  '  data._sentryCallerStore = als.getStore()',
  '  data._sentrySpan = getSpan(data)',
  '  return getStoreWithActiveSpan(data._sentrySpan)',
  '})',
  '',
];

const setupFrames = (): Step[] => [
  {
    depth: 0, kind: 'setup', title: 'getTracingChannelBinding()',
    detail: 'Ask the AsyncContextStrategy for { als, getStoreWithActiveSpan }.',
    caption: 'Enclosing request scope is active.',
    hl: [1], store: 'request', ctx: null, trace: tBefore(), tone: 'muted',
  },
  {
    depth: 0, kind: 'setup', title: 'start.bindStore(als, transform)',
    detail: 'Register the producer on the start sub-channel. Runs once, at wiring.',
    caption: 'The producer is registered but has not run yet.',
    hl: [3, 7], store: 'request', ctx: null, trace: tBefore(), tone: 'muted',
  },
];

const traceHead = (callTitle: string): Step[] => [
  {
    depth: 0, kind: 'call', title: callTitle,
    detail: 'The library / orchestrion runs the traced call. We never call this ourselves.',
    caption: 'Caller context is still active.',
    hl: [9], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
  },
  {
    depth: 1, kind: 'run', title: 'start.runStores(ctx, fn)',
    detail: 'Publish `start`, then enter the bound store for the duration of fn.',
    caption: 'About to run the producer and enter its store.',
    hl: [9], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
  },
  {
    depth: 2, kind: 'transform', title: 'transform(ctx)',
    detail: 'Stash the caller store, pick the span, produce the store value.',
    caption: 'Producer clones the scope and plants db.query on it.',
    hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), trace: tBefore(), tone: 'normal',
  },
  {
    depth: 2, kind: 'run', title: 'als.run(spanStore, fn)',
    detail: 'fn now executes inside our span store.',
    caption: 'Span store entered. New spans now parent to db.query.',
    hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'good',
  },
  {
    depth: 3, kind: 'event', channel: 'start', title: 'start',
    detail: 'start subscribers fire. Inside fn, getActiveSpan() === db.query.',
    caption: 'db.query is the active span for the traced operation.',
    hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
  },
];

const exitFrame = (
  detail = 'fn returns, the store exits, async context restored to the caller.',
  trace: SpanNode[] = tDone(),
): Step => ({
  depth: 1, kind: 'run', title: 'fn returns → store exits',
  detail, caption: 'Back in the caller context.',
  hl: [9], store: 'request', ctx: null, trace, tone: 'muted',
});

function traceSync(state: VState): Step[] {
  const head = [...setupFrames(), ...traceHead('channel.traceSync(fn, ctx)')];
  if (state.outcome === 'error') {
    return [
      ...head,
      {
        depth: 3, kind: 'event', channel: 'error', title: 'error',
        detail: 'Set error status + attributes on the span. Do NOT end here.',
        caption: 'error status set. The span is still open.',
        hl: [9], store: 'span', ctx: ctxError(), trace: tSpan(), tone: 'bad',
      },
      {
        depth: 3, kind: 'event', channel: 'end', title: 'end',
        detail: "'error' in data → threw synchronously, no async part → span.end().",
        caption: "'error' in data → end now (no async part is coming).",
        hl: [9], store: 'span', ctx: ctxError(), trace: tDone(), tone: 'event',
      },
      exitFrame(),
    ];
  }
  return [
    ...head,
    {
      depth: 3, kind: 'event', channel: 'end', title: 'end',
      detail: "'result' in data → settled synchronously → span.end().",
      caption: "'result' in data → end now (no async part is coming).",
      hl: [9], store: 'span', ctx: ctxResult(), trace: tDone(), tone: 'event',
    },
    exitFrame(),
  ];
}

function tracePromise(state: VState): Step[] {
  const head = [...setupFrames(), ...traceHead('await channel.tracePromise(fn, ctx)')];
  const endNoop: Step = {
    depth: 3, kind: 'event', channel: 'end', title: 'end',
    detail: 'Neither result nor error present yet → async part pending → NO-OP.',
    caption: 'end fires early, before the work finishes. NO-OP, span stays open.',
    hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
  };
  if (state.outcome === 'error') {
    return [
      ...head, endNoop,
      {
        depth: 3, kind: 'event', channel: 'error', title: 'error',
        detail: 'Promise rejected. Set error status on the span.',
        caption: 'Rejected. error status set; span still open.',
        hl: [9], store: 'span', ctx: ctxError(), trace: tSpan(), tone: 'bad',
      },
      {
        depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
        detail: 'No-op for us. Nothing to do here.',
        caption: 'asyncStart: nothing to do.',
        hl: [9], store: 'span', ctx: ctxError(), trace: tSpan(), tone: 'event',
      },
      {
        depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
        detail: 'The async part settled → span.end().',
        caption: 'asyncEnd → span.end().',
        hl: [9], store: 'span', ctx: ctxError(), trace: tDone(), tone: 'event',
      },
      exitFrame(),
    ];
  }
  return [
    ...head, endNoop,
    {
      depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
      detail: 'Promise resolved. No-op for us.',
      caption: 'Resolved. asyncStart: nothing to do.',
      hl: [9], store: 'span', ctx: ctxResult(), trace: tSpan(), tone: 'event',
    },
    {
      depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
      detail: 'The async part settled → span.end().',
      caption: 'asyncEnd → span.end().',
      hl: [9], store: 'span', ctx: ctxResult(), trace: tDone(), tone: 'event',
    },
    exitFrame(),
  ];
}

function traceCallback(state: VState): Step[] {
  const rebind = state.rebind !== 'off';
  const errored = state.outcome === 'error';
  const settled = errored ? ctxError() : ctxResult();
  const head = [...setupFrames(), ...traceHead('channel.traceCallback(fn, cb)')];
  const frames: Step[] = [
    ...head,
    {
      depth: 3, kind: 'event', channel: 'end', title: 'end',
      detail: 'Neither result nor error yet → async part pending → NO-OP.',
      caption: 'end fires early → NO-OP, span stays open.',
      hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
    },
  ];
  if (errored) {
    frames.push({
      depth: 3, kind: 'event', channel: 'error', title: 'error',
      detail: 'Callback received a truthy err argument → set error status.',
      caption: 'err argument present → error status set.',
      hl: [9], store: 'span', ctx: settled, trace: tSpan(), tone: 'bad',
    });
  }
  // asyncStart: with rebind we restore the caller store; without it we leak the span store.
  frames.push(
    rebind
      ? {
          depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
          detail: 'asyncStart re-enters its bound store: we restore the CALLER store.',
          caption: 'asyncStart restored the caller store.',
          hl: [9], store: 'request', ctx: settled, trace: tSpanReq(), tone: 'event',
        }
      : {
          depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
          detail: 'No rebind: the callback still runs inside OUR span store.',
          caption: 'No rebind → still in the span store. This will leak.',
          hl: [9], store: 'span', ctx: settled, trace: tSpan(), tone: 'warn',
        },
  );
  frames.push(
    rebind
      ? {
          depth: 3, kind: 'op', title: '(err, res) => { … }',
          detail: 'The user callback runs in the caller store; its spans nest under the request.',
          caption: 'renderRows() nests under the request. Correct.',
          hl: [12], store: 'request', ctx: settled,
          trace: [reqN(false), qN('open', false), childN(1, 'child', 'renderRows()')], tone: 'good',
        }
      : {
          depth: 3, kind: 'op', title: '(err, res) => { … }',
          detail: 'The callback runs in the span store; its spans leak under db.query.',
          caption: 'renderRows() leaks UNDER db.query. Wrong parent.',
          hl: [12], store: 'span', ctx: settled,
          trace: [reqN(false), qN('open', false), childN(2, 'warn', 'renderRows()')], tone: 'warn',
        },
  );
  frames.push({
    depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
    detail: 'span.end(). Ending is store-independent, so this is fine either way.',
    caption: 'asyncEnd → span.end().',
    hl: [9], store: rebind ? 'request' : 'span', ctx: settled,
    trace: [reqN(true), qN('closed', false), childN(rebind ? 1 : 2, rebind ? 'child' : 'warn', 'renderRows()', false, 'closed')],
    tone: 'event',
  });
  frames.push(exitFrame(
    'fn returns, the store exits.',
    [reqN(true), qN('closed', false), childN(rebind ? 1 : 2, rebind ? 'child' : 'bad', 'renderRows()', false, 'closed')],
  ));
  return frames;
}

function runStoresScenario(): Step[] {
  return [
    ...setupFrames(),
    {
      depth: 0, kind: 'call', title: 'channel.start.runStores(ctx, fn)',
      detail: 'Call runStores directly (no trace* wrapper).',
      caption: 'Caller context is still active.',
      hl: [9], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 1, kind: 'transform', title: 'transform(ctx)',
      detail: 'Same producer runs: stash caller, pick span, produce the store value.',
      caption: 'Producer plants db.query on a cloned scope.',
      hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 1, kind: 'run', title: 'als.run(spanStore, fn)',
      detail: 'fn executes inside the span store.',
      caption: 'Span store entered; db.query active.',
      hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'good',
    },
    {
      depth: 2, kind: 'event', channel: 'start', title: 'start',
      detail: 'start subscribers fire; getActiveSpan() === db.query.',
      caption: 'db.query is active.',
      hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
    },
    {
      depth: 2, kind: 'op', title: 'startChildSpan()',
      detail: 'Any span started here parents to db.query. Propagation works.',
      caption: 'The child nests under db.query. Propagation works.',
      hl: [10], store: 'span', ctx: ctxTransformed(),
      trace: [reqN(false), qN('open', false), childN(2, 'child', 'child span')], tone: 'good',
    },
    exitFrame(
      'fn returns, store exits. runStores has NO end / asyncEnd, so db.query is still open, you manage it.',
      [reqN(true), qN('open', false), childN(2, 'child', 'child span', false)],
    ),
  ];
}

function publish(state: VState): Step[] {
  if (state.store === 'on') {
    // Toggle: what if we entered a store instead (runStores)? Propagation is restored.
    return [
      ...setupFrames(),
      {
        depth: 0, kind: 'call', title: 'channel.start.runStores(ctx, fn)',
        detail: 'With a store entered, the producer runs and db.query becomes active.',
        caption: 'Entering a store: the producer runs.',
        hl: [9], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
      },
      {
        depth: 1, kind: 'transform', title: 'transform(ctx)',
        detail: 'Producer plants db.query on a cloned scope.',
        caption: 'db.query planted on the scope.',
        hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), trace: tBefore(), tone: 'normal',
      },
      {
        depth: 1, kind: 'run', title: 'als.run(spanStore, fn)',
        detail: 'fn runs inside the span store.',
        caption: 'Span store entered; db.query active.',
        hl: [9], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'good',
      },
      {
        depth: 2, kind: 'op', title: 'later work',
        detail: 'Work started here parents to db.query. Propagation works.',
        caption: 'Later work nests under db.query. Propagation works.',
        hl: [10], store: 'span', ctx: ctxTransformed(),
        trace: [reqN(false), qN('open', false), childN(2, 'child', 'later work')], tone: 'good',
      },
    ];
  }
  return [
    ...setupFrames(),
    {
      depth: 0, kind: 'call', title: 'channel.start.publish(ctx)',
      detail: 'publish() only notifies subscribers.',
      caption: 'publish only notifies subscribers.',
      hl: [9], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 1, kind: 'event', channel: 'publish', title: 'start (published)',
      detail: 'A subscriber may open db.query, but NO store is entered.',
      caption: 'db.query opened, but no store is entered.',
      hl: [9], store: 'request', ctx: ctxBase(), trace: tSpanReq(), tone: 'event',
    },
    {
      depth: 1, kind: 'op', title: 'transform never runs',
      detail: 'publish does not runStores → the producer is skipped → no store swap.',
      caption: 'Producer skipped. db.query never becomes active.',
      hl: [10], store: 'request', ctx: ctxBase(), trace: tSpanReq(), tone: 'warn',
    },
    {
      depth: 1, kind: 'op', title: 'later work',
      detail: 'Later work parents to the request, NOT db.query. No propagation.',
      caption: 'Later work parents to the request, not db.query. No propagation.',
      hl: [10], store: 'none', ctx: ctxBase(),
      trace: [reqN(false), qN('open', false), childN(1, 'warn', 'later work')], tone: 'warn',
    },
  ];
}

function falsy(): Step[] {
  const c: Ctx = { arguments: [SQL], _sentryCallerStore: '⟨ request scope ⟩', _sentrySpan: '⟨ span: db.query ⟩', error: 0 };
  return [
    ...setupFrames(),
    ...traceHead('channel.traceSync(() => { throw 0 }, ctx)'),
    {
      depth: 3, kind: 'event', channel: 'error', title: 'error',
      detail: 'The thrown value is 0 (falsy). error status is still set.',
      caption: "The thrown value is 0. `if (data.error)` would be FALSE.",
      hl: [9], store: 'span', ctx: c, trace: tSpan(), tone: 'bad',
    },
    {
      depth: 3, kind: 'event', channel: 'end', title: 'end',
      detail: "'error' in data is TRUE even though the value is falsy → span.end().",
      caption: "'error' in data is TRUE → end. Presence check, not truthiness.",
      hl: [9], store: 'span', ctx: c, trace: tDone(), tone: 'event',
    },
    exitFrame(),
  ];
}

function graphql(state: VState): Step[] {
  const sync = state.mode === 'sync';
  const result = '{ id: 1, title: "…" }';
  const head: Step[] = [
    ...setupFrames(),
    {
      depth: 0, kind: 'call', title: 'graphql resolves a field',
      detail: 'graphql-js wraps every resolver in one traceMixed helper.',
      caption: 'Caller context is still active.',
      hl: [10], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 1, kind: 'run', title: 'channel.start.runStores(ctx, fn)',
      detail: 'traceMixed publishes `start` and enters the bound store for fn.',
      caption: 'About to run the producer and enter its store.',
      hl: [11], store: 'request', ctx: ctxBase(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 2, kind: 'transform', title: 'transform(ctx)',
      detail: 'Our producer clones the scope and plants db.query on it.',
      caption: 'Producer plants db.query on a cloned scope.',
      hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), trace: tBefore(), tone: 'normal',
    },
    {
      depth: 2, kind: 'run', title: 'als.run(spanStore, fn)',
      detail: 'fn (the resolver) runs inside our span store.',
      caption: 'Span store entered; db.query active.',
      hl: [11], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'good',
    },
    {
      depth: 3, kind: 'event', channel: 'start', title: 'start',
      detail: 'start fires; getActiveSpan() === db.query.',
      caption: 'db.query is active for the resolver.',
      hl: [11], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
    },
  ];
  if (sync) {
    return [
      ...head,
      {
        depth: 3, kind: 'event', channel: 'end', title: 'end',
        detail: 'Resolver returned a value (not a thenable): result is set, then end fires. \'result\' in data → span.end().',
        caption: 'Sync resolver: result present at end → span.end() now.',
        hl: [19, 20], store: 'span', ctx: { ...ctxTransformed(), result }, trace: tDone(), tone: 'event',
      },
      exitFrame(),
    ];
  }
  return [
    ...head,
    {
      depth: 3, kind: 'event', channel: 'end', title: 'end',
      detail: 'Resolver returned a promise. traceMixed publishes `end` NOW, before it settles, so neither result nor error is present → NO-OP.',
      caption: 'Async resolver: end fires early with NO result → NO-OP. Same channel, different shape.',
      hl: [23], store: 'span', ctx: ctxTransformed(), trace: tSpan(), tone: 'event',
    },
    {
      depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
      detail: 'The resolver promise resolved; asyncStart fires (with the result now attached).',
      caption: 'asyncStart: nothing to do.',
      hl: [26], store: 'span', ctx: { ...ctxTransformed(), result }, trace: tSpan(), tone: 'event',
    },
    {
      depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
      detail: 'asyncEnd → span.end().',
      caption: 'asyncEnd → span.end().',
      hl: [27], store: 'span', ctx: { ...ctxTransformed(), result }, trace: tDone(), tone: 'event',
    },
    exitFrame(),
  ];
}

const outcomeVariant = (a: string, b: string): Variant => ({
  key: 'outcome', label: 'outcome',
  options: [{ value: 'success', label: a }, { value: 'error', label: b }],
});

export const SCENARIOS: Scenario[] = [
  {
    id: 'traceSync', label: 'traceSync',
    blurb: 'Synchronous call. start → (error) → end. No async events. The span ends on `end` because result/error is already present.',
    variants: [outcomeVariant('success', 'error')],
    code: () => [...WIRE, 'channel.traceSync(() => db.query(sql), ctx)'],
    build: traceSync,
  },
  {
    id: 'tracePromise', label: 'tracePromise',
    blurb: 'Promise-returning call. `end` fires early (before the work finishes) with no result, so we no-op and wait for asyncEnd.',
    variants: [outcomeVariant('resolves', 'rejects')],
    code: () => [...WIRE, 'await channel.tracePromise(() => db.query(sql), ctx)'],
    build: tracePromise,
  },
  {
    id: 'traceCallback', label: 'traceCallback',
    blurb: 'Callback-style call. Node re-enters a store for the user callback via asyncStart. Toggle the rebind to watch the callback leak under db.query.',
    variants: [
      outcomeVariant('success', 'error'),
      { key: 'rebind', label: 'asyncStart rebind', options: [{ value: 'on', label: 'rebind on' }, { value: 'off', label: 'rebind off (bug)' }] },
    ],
    code: () => [
      ...WIRE,
      'channel.traceCallback(',
      '  (cb) => db.query(sql, cb),   // arg carrying the callback',
      '  -1, ctx, null,',
      '  (err, res) => renderRows(res),   // your callback',
      ')',
    ],
    build: traceCallback,
  },
  {
    id: 'runStores', label: 'runStores (start)',
    blurb: 'Calling start.runStores directly. It enters the store and publishes `start`, but there is NO end / asyncEnd lifecycle.',
    variants: [],
    code: () => [
      ...WIRE,
      'channel.start.runStores(ctx, () => {',
      '  startChildSpan()   // parents to db.query',
      '})',
    ],
    build: runStoresScenario,
  },
  {
    id: 'publish', label: 'publish (no store)',
    blurb: 'Plain publish. Subscribers fire but no store is entered, so nothing propagates. Toggle "enter store" to see propagation restored.',
    variants: [
      { key: 'store', label: 'store', options: [{ value: 'off', label: 'publish (no store)' }, { value: 'on', label: 'enter store (runStores)' }] },
    ],
    code: (state) => state.store === 'on'
      ? [...WIRE, 'channel.start.runStores(ctx, () => {', '  laterWork()   // parents to db.query', '})']
      : [...WIRE, 'channel.start.publish(ctx)   // no store entered', '// transform never runs; the span is never activated'],
    build: publish,
  },
  {
    id: 'falsy', label: 'falsy trap',
    blurb: 'Why we use presence checks, not truthiness. A thrown 0 (or an undefined result) is falsy, so `if (data.error)` would miss it, but `\'error\' in data` catches it.',
    variants: [],
    code: () => [...WIRE, 'channel.traceSync(() => { throw 0 }, ctx)   // falsy throw'],
    build: falsy,
  },
  {
    id: 'graphql', label: 'sync-or-async',
    blurb: 'The GraphQL caveat: graphql-js wraps every resolver in one `traceMixed` helper. It publishes `end` for BOTH sync and async resolvers, but for async, `end` fires early with no result. So you cannot pair start/asyncEnd; the `\'result\' in data` check at `end` is what tells them apart.',
    variants: [
      { key: 'mode', label: 'resolver', options: [{ value: 'async', label: 'async resolver' }, { value: 'sync', label: 'sync resolver' }] },
    ],
    code: () => [
      ...WIRE,
      '// graphql-js internal (src/diagnostics.ts):',
      'function traceMixed(channel, ctx, fn) {',
      '  return channel.start.runStores(ctx, () => {',
      '    let result',
      '    try { result = fn() } catch (err) {',
      '      ctx.error = err',
      '      channel.error.publish(ctx)',
      '      channel.end.publish(ctx); throw err',
      '    }',
      '    if (!isPromiseLike(result)) {        // sync',
      '      ctx.result = result',
      '      channel.end.publish(ctx)',
      '      return result',
      '    }',
      '    channel.end.publish(ctx)             // async: end before settle',
      '    return result.then(v => {',
      '      ctx.result = v',
      '      channel.asyncStart.publish(ctx)',
      '      channel.asyncEnd.publish(ctx)',
      '    })',
      '  })',
      '}',
    ],
    build: graphql,
  },
];
