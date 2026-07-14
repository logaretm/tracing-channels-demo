import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { SCENARIOS } from './scenarios';
import type { Step, Scenario, StoreKey, SpanNode, VState } from './scenarios';

interface StoreMeta { title: string; active: string; cls: string; }
const STORE: Record<StoreKey, StoreMeta> = {
  request: { title: 'caller / enclosing scope', active: 'GET /orders', cls: 'caller' },
  span: { title: 'our span store', active: 'db.query', cls: 'span' },
  none: { title: 'no store entered', active: 'GET /orders (unchanged)', cls: 'none' },
};

const defaultsFor = (sc: Scenario): VState =>
  Object.fromEntries(sc.variants.map(v => [v.key, v.options[0].value]));

// ---- URL hash (deep-linking) ----
function readHash(): { sid?: string; variants: VState; step?: number } {
  const raw = typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '') : '';
  if (!raw) return { variants: {} };
  const parts = raw.split('&');
  const sid = parts.shift();
  const variants: VState = {};
  let step: number | undefined;
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (!k || v === undefined) continue;
    if (k === 'step') step = Number(v);
    else variants[k] = v;
  }
  return { sid, variants, step };
}
function writeHash(sid: string, variants: VState, step: number) {
  const parts = [sid, ...Object.entries(variants).map(([k, v]) => `${k}=${v}`), `step=${step}`];
  window.history.replaceState(null, '', `#${parts.join('&')}`);
}

const boot = readHash();
const bootSid = SCENARIOS.some(s => s.id === boot.sid) ? boot.sid! : 'traceSync';
const bootVariants = { ...defaultsFor(SCENARIOS.find(s => s.id === bootSid)!), ...boot.variants };

function StoreBanner({ store, caption }: { store: StoreMeta; caption?: string }) {
  return (
    <div className={`store store-${store.cls}`}>
      <div className="store-head">
        <span className="store-dot" />
        <span className="store-title">Active async context</span>
        <span className="store-name">{store.title}</span>
      </div>
      <div className="store-active">
        <code>getActiveSpan()</code>
        <span className="arrow">→</span>
        <strong>{store.active}</strong>
      </div>
      {caption && <div className="store-caption">{caption}</div>}
    </div>
  );
}

function Waterfall({ trace }: { trace: SpanNode[] }) {
  return (
    <div className="waterfall">
      <div className="wf-title">Resulting trace</div>
      {trace.map((n, i) => (
        <div key={i} className={`wf-row tone-${n.tone} state-${n.state}${n.active ? ' active' : ''}`}>
          <span className="wf-label" style={{ paddingLeft: n.depth * 16 }}>
            <span className="wf-dot" />
            {n.name}
            {n.state === 'closed' && <span className="wf-tag">ended</span>}
          </span>
          <span className="wf-track">
            <span className="wf-bar" style={{ marginLeft: n.depth * 34, width: `calc(100% - ${n.depth * 34}px)` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function StepRow({ s, i, cur, sel, onClick }: {
  s: Step; i: number; cur: number; sel: number; onClick: () => void;
}) {
  const rel = i === cur ? 'current' : i < cur ? 'past' : 'future';
  const cls = ['step', `depth-${s.depth}`, `tone-${s.tone}`, rel, i === sel ? 'selected' : '']
    .filter(Boolean).join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={i > cur}>
      {s.channel
        ? <span className={`chan chan-${s.channel}`}>{s.channel}</span>
        : <span className={`kind kind-${s.kind}`}>{s.kind}</span>}
      <span className="step-title">{s.title}</span>
    </button>
  );
}

function CodePanel({ lines, hl }: { lines: string[]; hl: Set<number> }) {
  return (
    <pre className="code">
      {lines.map((line, i) => {
        const [code, ...rest] = line.split('//');
        const comment = rest.length ? '//' + rest.join('//') : '';
        return (
          <div key={i} className={`ln${hl.has(i) ? ' hl' : ''}`}>
            <span className="gutter">{i + 1}</span>
            <span className="src">{code}{comment && <span className="cmt">{comment}</span>}</span>
          </div>
        );
      })}
    </pre>
  );
}

function Inspector({ step, changed }: { step: Step; changed: Set<string> }) {
  const ctx = step.ctx;
  return (
    <div className="inspector">
      <div className="insp-head">
        <span className={`kind kind-${step.kind}`}>{step.channel || step.kind}</span>
        <span className="insp-title">{step.title}</span>
      </div>
      <p className="insp-detail">{step.detail}</p>
      <div className="insp-payload">
        <div className="payload-label">context object (data)</div>
        {ctx ? (
          <div className="kv">
            {Object.entries(ctx).map(([k, v]) => {
              const disc = k === 'result' || k === 'error';
              return (
                <div key={k} className={`row${disc ? ' disc' : ''}${changed.has(k) ? ' changed' : ''}`}>
                  <span className="k">{k}</span>
                  <span className="v">{Array.isArray(v) ? `[ "${v.join('", "')}" ]` : String(v)}</span>
                  {disc && <span className="present">'{k}' in data</span>}
                  {changed.has(k) && !disc && <span className="just">new</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty">no payload at this frame</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [sid, setSid] = useState<string>(bootSid);
  const [variants, setVariants] = useState<VState>(bootVariants);
  const [cur, setCur] = useState(boot.step ?? 0);
  const [sel, setSel] = useState(boot.step ?? 0);
  const [playing, setPlaying] = useState(false);

  const scenario = useMemo<Scenario>(() => SCENARIOS.find(s => s.id === sid)!, [sid]);
  const steps = useMemo<Step[]>(() => scenario.build(variants), [scenario, variants]);
  const codeLines = useMemo(() => scenario.code(variants), [scenario, variants]);

  const curSafe = Math.min(cur, steps.length - 1);
  const selSafe = Math.min(sel, steps.length - 1);

  const curRef = useRef(curSafe);
  curRef.current = curSafe;
  const lenRef = useRef(steps.length);
  lenRef.current = steps.length;

  const step = useCallback((d: number) => {
    const n = Math.min(Math.max(curRef.current + d, 0), lenRef.current - 1);
    setCur(n);
    setSel(n);
  }, []);
  const reset = useCallback(() => { setCur(0); setSel(0); setPlaying(false); }, []);

  const pickScenario = (id: string) => {
    const sc = SCENARIOS.find(s => s.id === id)!;
    setSid(id);
    setVariants(defaultsFor(sc));
    setCur(0); setSel(0); setPlaying(false);
  };
  const setVariant = (key: string, value: string) => {
    setVariants(v => ({ ...v, [key]: value }));
    setCur(0); setSel(0); setPlaying(false);
  };

  // auto-play
  useEffect(() => {
    if (!playing) return;
    if (curSafe >= steps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => step(1), 850);
    return () => clearTimeout(t);
  }, [playing, curSafe, steps.length, step]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
      else if (e.key === 'r') { reset(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, reset]);

  // deep-link hash
  useEffect(() => { writeHash(sid, variants, curSafe); }, [sid, variants, curSafe]);

  const atEnd = curSafe >= steps.length - 1;
  const curStep = steps[curSafe];
  const curStore = STORE[curStep.store];
  const hl = new Set<number>(curStep.hl);

  // payload diff vs previous frame in the sequence
  const changed = useMemo(() => {
    const set = new Set<string>();
    const cur2 = steps[selSafe].ctx;
    const prev = selSafe > 0 ? steps[selSafe - 1].ctx : null;
    if (cur2) {
      for (const [k, v] of Object.entries(cur2)) {
        if (!prev || !(k in prev) || String(prev[k]) !== String(v)) set.add(k);
      }
    }
    return set;
  }, [steps, selSafe]);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Tracing Channels Playground</h1>
          <p>Step through the diagnostics_channel lifecycle. Watch the async context, the payload, and the resulting trace change on every event.</p>
        </div>
        <span className="badge">simulated · verified order (Node 20–26)</span>
      </header>

      <main>
        <section className="left">
          <div className="controls">
            <button onClick={reset}>↺ Reset</button>
            <button onClick={() => step(-1)} disabled={curSafe === 0}>‹ Prev</button>
            <button onClick={() => step(1)} disabled={atEnd}>Step ›</button>
            <button className="primary" onClick={() => setPlaying(p => !p)} disabled={atEnd && !playing}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <span className="progress">{curSafe + 1} / {steps.length}</span>
          </div>
          <div className="kbd-hint">← → step · space play · r reset</div>

          <StoreBanner store={curStore} caption={curStep.caption} />
          <Waterfall trace={curStep.trace} />

          <div className="stack">
            {steps.map((s, i) => (
              <StepRow key={i} s={s} i={i} cur={curSafe} sel={selSafe} onClick={() => i <= curSafe && setSel(i)} />
            ))}
          </div>
        </section>

        <section className="right">
          <div className="tabs">
            {SCENARIOS.map(s => (
              <button key={s.id} className={`tab${s.id === sid ? ' active' : ''}`} onClick={() => pickScenario(s.id)}>
                {s.label}
              </button>
            ))}
          </div>

          <p className="blurb">{scenario.blurb}</p>

          {scenario.variants.map(v => (
            <div className="toggle" key={v.key}>
              <span>{v.label}</span>
              {v.options.map(o => (
                <button
                  key={o.value}
                  className={variants[v.key] === o.value ? 'on' : ''}
                  onClick={() => setVariant(v.key, o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}

          <CodePanel lines={codeLines} hl={hl} />
          <Inspector step={steps[selSafe]} changed={changed} />
        </section>
      </main>
    </div>
  );
}
