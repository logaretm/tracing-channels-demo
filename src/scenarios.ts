// A faithful simulation of the diagnostics_channel tracing-channel lifecycle.
// Event orders are the ones we verified empirically on Node 20-26.
//
// Each scenario is a list of ordered "frames" (steps). A frame records:
//   depth   -> indentation, to read like a call stack
//   kind    -> setup | call | run | transform | event | op
//   channel -> for event frames: start | end | asyncStart | asyncEnd | error | publish
//   store   -> what the active AsyncLocalStorage returns right now: request | span | none
//   ctx     -> the shared tracing-channel context object at this point (inspectable)
//   hl      -> code line indices to highlight
//   tone    -> visual accent

export type StoreKey = 'request' | 'span' | 'none';
export type Channel = 'start' | 'end' | 'asyncStart' | 'asyncEnd' | 'error' | 'publish';
export type Kind = 'setup' | 'call' | 'run' | 'transform' | 'event' | 'op';
export type Tone = 'muted' | 'normal' | 'good' | 'bad' | 'event';
export type Outcome = 'success' | 'error';

export type Ctx = Record<string, unknown>;

export interface Step {
  depth: number;
  kind: Kind;
  channel?: Channel;
  title: string;
  detail: string;
  hl: number[];
  store: StoreKey;
  ctx: Ctx | null;
  tone: Tone;
}

export interface Scenario {
  id: string;
  label: string;
  supportsOutcome: boolean;
  blurb: string;
  code: string[];
  build: (outcome: Outcome) => Step[];
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

// Shared wiring shown at the top of every scenario's code (lines 0-8).
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
    hl: [1], store: 'request', ctx: null, tone: 'muted',
  },
  {
    depth: 0, kind: 'setup', title: 'start.bindStore(als, transform)',
    detail: 'Register the producer on the start sub-channel. Runs once, at wiring.',
    hl: [3, 7], store: 'request', ctx: null, tone: 'muted',
  },
];

// The shared runtime head for the trace* helpers: the library calls trace*, which
// runs the op inside the bound store via start.runStores, firing `start`.
const traceHead = (callTitle: string): Step[] => [
  {
    depth: 0, kind: 'call', title: callTitle,
    detail: 'The library / orchestrion runs the traced call. We never call this ourselves.',
    hl: [9], store: 'request', ctx: ctxBase(), tone: 'normal',
  },
  {
    depth: 1, kind: 'run', title: 'start.runStores(ctx, fn)',
    detail: 'Publish `start`, then enter the bound store for the duration of fn.',
    hl: [9], store: 'request', ctx: ctxBase(), tone: 'normal',
  },
  {
    depth: 2, kind: 'transform', title: 'transform(ctx)',
    detail: 'Stash the caller store, pick the span, produce the store value.',
    hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), tone: 'normal',
  },
  {
    depth: 2, kind: 'run', title: 'als.run(spanStore, fn)',
    detail: 'fn now executes inside our span store.',
    hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'good',
  },
  {
    depth: 3, kind: 'event', channel: 'start', title: 'start',
    detail: 'start subscribers fire. Inside fn, getActiveSpan() === db.query.',
    hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'event',
  },
];

const exitFrame = (
  detail = 'fn returns, the store exits, async context restored to the caller.',
): Step => ({
  depth: 1, kind: 'run', title: 'fn returns → store exits',
  detail, hl: [9], store: 'request', ctx: null, tone: 'muted',
});

function traceSync(outcome: Outcome): Step[] {
  const head = [...setupFrames(), ...traceHead('channel.traceSync(fn, ctx)')];
  if (outcome === 'error') {
    return [
      ...head,
      {
        depth: 3, kind: 'event', channel: 'error', title: 'error',
        detail: 'Set error status + attributes on the span. Do NOT end here.',
        hl: [9], store: 'span', ctx: ctxError(), tone: 'bad',
      },
      {
        depth: 3, kind: 'event', channel: 'end', title: 'end',
        detail: "'error' in data → threw synchronously, no async part → span.end().",
        hl: [9], store: 'span', ctx: ctxError(), tone: 'event',
      },
      exitFrame(),
    ];
  }
  return [
    ...head,
    {
      depth: 3, kind: 'event', channel: 'end', title: 'end',
      detail: "'result' in data → settled synchronously → span.end().",
      hl: [9], store: 'span', ctx: ctxResult(), tone: 'event',
    },
    exitFrame(),
  ];
}

function tracePromise(outcome: Outcome): Step[] {
  const head = [...setupFrames(), ...traceHead('await channel.tracePromise(fn, ctx)')];
  const endNoop: Step = {
    depth: 3, kind: 'event', channel: 'end', title: 'end',
    detail: 'Neither result nor error present yet → async part pending → NO-OP.',
    hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'event',
  };
  if (outcome === 'error') {
    return [
      ...head, endNoop,
      {
        depth: 3, kind: 'event', channel: 'error', title: 'error',
        detail: 'Promise rejected. Set error status on the span.',
        hl: [9], store: 'span', ctx: ctxError(), tone: 'bad',
      },
      {
        depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
        detail: 'No-op for us. Nothing to do here.',
        hl: [9], store: 'span', ctx: ctxError(), tone: 'event',
      },
      {
        depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
        detail: 'The async part settled → span.end().',
        hl: [9], store: 'span', ctx: ctxError(), tone: 'event',
      },
      exitFrame(),
    ];
  }
  return [
    ...head, endNoop,
    {
      depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
      detail: 'Promise resolved. No-op for us.',
      hl: [9], store: 'span', ctx: ctxResult(), tone: 'event',
    },
    {
      depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
      detail: 'The async part settled → span.end().',
      hl: [9], store: 'span', ctx: ctxResult(), tone: 'event',
    },
    exitFrame(),
  ];
}

function traceCallback(outcome: Outcome): Step[] {
  const head = [...setupFrames(), ...traceHead('channel.traceCallback(fn, cb)')];
  const endNoop: Step = {
    depth: 3, kind: 'event', channel: 'end', title: 'end',
    detail: 'Neither result nor error yet → async part pending → NO-OP.',
    hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'event',
  };
  const errored = outcome === 'error';
  const settled = errored ? ctxError() : ctxResult();
  const frames: Step[] = [...head, endNoop];
  if (errored) {
    frames.push({
      depth: 3, kind: 'event', channel: 'error', title: 'error',
      detail: 'Callback received a truthy err argument → set error status.',
      hl: [9], store: 'span', ctx: settled, tone: 'bad',
    });
  }
  frames.push({
    depth: 3, kind: 'event', channel: 'asyncStart', title: 'asyncStart',
    detail: 'About to invoke the user callback. asyncStart re-enters its bound store.',
    hl: [9], store: 'request', ctx: settled, tone: 'event',
  });
  frames.push({
    depth: 3, kind: 'op', title: '(err, res) => { … }',
    detail: 'The user callback runs. asyncStart restored the CALLER store, so their work nests correctly.',
    hl: [12], store: 'request', ctx: settled, tone: 'good',
  });
  frames.push({
    depth: 3, kind: 'event', channel: 'asyncEnd', title: 'asyncEnd',
    detail: 'span.end(). (Store is the caller here, which is fine, ending is store-independent.)',
    hl: [9], store: 'request', ctx: settled, tone: 'event',
  });
  frames.push(exitFrame());
  return frames;
}

function runStores(): Step[] {
  return [
    ...setupFrames(),
    {
      depth: 0, kind: 'call', title: 'channel.start.runStores(ctx, fn)',
      detail: 'Call runStores directly (no trace* wrapper).',
      hl: [9], store: 'request', ctx: ctxBase(), tone: 'normal',
    },
    {
      depth: 1, kind: 'transform', title: 'transform(ctx)',
      detail: 'Same producer runs: stash caller, pick span, produce the store value.',
      hl: [4, 5, 6], store: 'request', ctx: ctxTransformed(), tone: 'normal',
    },
    {
      depth: 1, kind: 'run', title: 'als.run(spanStore, fn)',
      detail: 'fn executes inside the span store.',
      hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'good',
    },
    {
      depth: 2, kind: 'event', channel: 'start', title: 'start',
      detail: 'start subscribers fire; getActiveSpan() === db.query.',
      hl: [9], store: 'span', ctx: ctxTransformed(), tone: 'event',
    },
    {
      depth: 2, kind: 'op', title: 'startChildSpan()',
      detail: 'Any span started here parents to db.query. Propagation works.',
      hl: [10], store: 'span', ctx: ctxTransformed(), tone: 'good',
    },
    exitFrame('fn returns, store exits. runStores has NO end / asyncEnd, you manage the span yourself.'),
  ];
}

function publish(): Step[] {
  return [
    ...setupFrames(),
    {
      depth: 0, kind: 'call', title: 'channel.start.publish(ctx)',
      detail: 'publish() only notifies subscribers.',
      hl: [9], store: 'request', ctx: ctxBase(), tone: 'normal',
    },
    {
      depth: 1, kind: 'event', channel: 'publish', title: 'start (published)',
      detail: 'start subscribers fire, but NO store is entered.',
      hl: [9], store: 'request', ctx: ctxBase(), tone: 'event',
    },
    {
      depth: 1, kind: 'op', title: 'transform never runs',
      detail: 'publish does not runStores → the producer is skipped → no _sentrySpan is ever set.',
      hl: [10], store: 'request', ctx: ctxBase(), tone: 'bad',
    },
    {
      depth: 1, kind: 'op', title: 'getActiveSpan() === GET /orders',
      detail: 'db.query never became active → child work will NOT nest → no propagation.',
      hl: [10], store: 'none', ctx: ctxBase(), tone: 'bad',
    },
  ];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'traceSync', label: 'traceSync', supportsOutcome: true,
    blurb: 'Synchronous call. start → (error) → end. No async events. The span ends on `end` because result/error is already present.',
    code: [...WIRE, 'channel.traceSync(() => db.query(sql), ctx)'],
    build: traceSync,
  },
  {
    id: 'tracePromise', label: 'tracePromise', supportsOutcome: true,
    blurb: 'Promise-returning call. `end` fires early (before the work finishes) with no result, so we no-op and wait for asyncEnd.',
    code: [...WIRE, 'await channel.tracePromise(() => db.query(sql), ctx)'],
    build: tracePromise,
  },
  {
    id: 'traceCallback', label: 'traceCallback', supportsOutcome: true,
    blurb: 'Callback-style call. Node re-enters a store for the user callback via asyncStart, which is why we rebind it to the caller store.',
    code: [
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
    id: 'runStores', label: 'runStores (start)', supportsOutcome: false,
    blurb: 'Calling start.runStores directly. It enters the store and publishes `start`, but there is NO end / asyncEnd lifecycle.',
    code: [
      ...WIRE,
      'channel.start.runStores(ctx, () => {',
      '  startChildSpan()   // parents to db.query',
      '})',
    ],
    build: runStores,
  },
  {
    id: 'publish', label: 'publish (no store)', supportsOutcome: false,
    blurb: 'Plain publish. Subscribers fire but no store is entered, so the producer never runs and nothing propagates. The contrast case.',
    code: [
      ...WIRE,
      'channel.start.publish(ctx)   // no store entered',
      '// transform never runs; the span is never activated',
    ],
    build: publish,
  },
];
