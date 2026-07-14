# Tracing Channels Playground

Interactive demo of the `node:diagnostics_channel` tracing-channel lifecycle and how
Sentry binds a span into the async context. Simulated (no Node runtime needed); event
orders match what we verified on Node 20-26.

## Run

    npm install
    npm run dev      # http://localhost:5173

## What it shows

Right column: pick a scenario (`traceSync`, `tracePromise`, `traceCallback`,
`runStores`, plain `publish`) and, where relevant, a success/error outcome. The code
panel highlights the active line as you step.

Left column: a call-stack-like view of the lifecycle. Step (or Play) through it and
watch two things update per frame:
- the **active async context** (what `getActiveSpan()` / `getStore()` resolves to), and
- the **context object payload** (click any revealed frame to inspect it).

The payoff frames: `traceCallback` shows the store flip back to the caller during the
user callback (why we rebind `asyncStart`); `publish` shows the store never changing
(no propagation).
