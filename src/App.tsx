import { useState, useMemo, useEffect } from 'react';
import { SCENARIOS } from './scenarios';
import type { Step, Scenario, Outcome, StoreKey } from './scenarios';

interface StoreMeta {
  title: string;
  active: string;
  cls: string;
}

const STORE: Record<StoreKey, StoreMeta> = {
  request: { title: 'caller / enclosing scope', active: 'GET /orders', cls: 'caller' },
  span: { title: 'our span store', active: 'db.query', cls: 'span' },
  none: { title: 'no store entered', active: 'GET /orders (unchanged)', cls: 'none' },
};

function StoreBanner({ store }: { store: StoreMeta }) {
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
    </div>
  );
}

function StepRow({
  s, i, cur, sel, onClick,
}: {
  s: Step;
  i: number;
  cur: number;
  sel: number;
  onClick: () => void;
}) {
  const rel = i === cur ? 'current' : i < cur ? 'past' : 'future';
  const cls = ['step', `depth-${s.depth}`, `tone-${s.tone}`, rel, i === sel ? 'selected' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} onClick={onClick} disabled={i > cur}>
      <span className="rail" />
      {s.channel ? (
        <span className={`chan chan-${s.channel}`}>{s.channel}</span>
      ) : (
        <span className={`kind kind-${s.kind}`}>{s.kind}</span>
      )}
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
            <span className="src">
              {code}
              {comment && <span className="cmt">{comment}</span>}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

function Inspector({ step }: { step: Step }) {
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
                <div key={k} className={`row${disc ? ' disc' : ''}`}>
                  <span className="k">{k}</span>
                  <span className="v">{Array.isArray(v) ? `[ "${v.join('", "')}" ]` : String(v)}</span>
                  {disc && <span className="present">'{k}' in data</span>}
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
  const [sid, setSid] = useState<string>('traceSync');
  const [outcome, setOutcome] = useState<Outcome>('success');
  const scenario = useMemo<Scenario>(() => SCENARIOS.find(s => s.id === sid)!, [sid]);
  const steps = useMemo<Step[]>(() => scenario.build(outcome), [scenario, outcome]);
  const [cur, setCur] = useState(0);
  const [sel, setSel] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setCur(0);
    setSel(0);
    setPlaying(false);
  }, [sid, outcome]);

  useEffect(() => {
    if (!playing) return;
    if (cur >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setCur(c => {
      const n = Math.min(c + 1, steps.length - 1);
      setSel(n);
      return n;
    }), 850);
    return () => clearTimeout(t);
  }, [playing, cur, steps.length]);

  const atEnd = cur >= steps.length - 1;
  const move = (d: number) => setCur(c => {
    const n = Math.min(Math.max(c + d, 0), steps.length - 1);
    setSel(n);
    return n;
  });
  const reset = () => {
    setCur(0);
    setSel(0);
    setPlaying(false);
  };

  const curStore = STORE[steps[cur].store];
  const hl = new Set<number>(steps[cur].hl);

  return (
    <div className="app">
      <header>
        <div>
          <h1>Tracing Channels Playground</h1>
          <p>Step through the diagnostics_channel lifecycle. Watch the async context store and the payload change on every event.</p>
        </div>
        <span className="badge">simulated · verified order (Node 20–26)</span>
      </header>

      <main>
        <section className="left">
          <div className="controls">
            <button onClick={reset}>↺ Reset</button>
            <button onClick={() => move(-1)} disabled={cur === 0}>‹ Prev</button>
            <button onClick={() => move(1)} disabled={atEnd}>Step ›</button>
            <button className="primary" onClick={() => setPlaying(p => !p)} disabled={atEnd && !playing}>
              {playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <span className="progress">{cur + 1} / {steps.length}</span>
          </div>

          <StoreBanner store={curStore} />

          <div className="stack">
            {steps.map((s, i) => (
              <StepRow
                key={i}
                s={s}
                i={i}
                cur={cur}
                sel={sel}
                onClick={() => i <= cur && setSel(i)}
              />
            ))}
          </div>
        </section>

        <section className="right">
          <div className="tabs">
            {SCENARIOS.map(s => (
              <button key={s.id} className={`tab${s.id === sid ? ' active' : ''}`} onClick={() => setSid(s.id)}>
                {s.label}
              </button>
            ))}
          </div>

          <p className="blurb">{scenario.blurb}</p>

          {scenario.supportsOutcome && (
            <div className="toggle">
              <span>outcome</span>
              <button className={outcome === 'success' ? 'on' : ''} onClick={() => setOutcome('success')}>success</button>
              <button className={outcome === 'error' ? 'on error' : ''} onClick={() => setOutcome('error')}>error</button>
            </div>
          )}

          <CodePanel lines={scenario.code} hl={hl} />

          <Inspector step={steps[sel]} />
        </section>
      </main>
    </div>
  );
}
