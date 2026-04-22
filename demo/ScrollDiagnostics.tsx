import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

// Live-overlay diagnostics for tracking down the iOS momentum-scroll
// halt. Shows the current scrollTop / scrollHeight / clientHeight of
// the CM6 scroller, plus a rolling log of every scrollHeight change
// — those are the events that correlate with iOS aborting kinetic
// scrolling (the thumb jumps because the scroll container's total
// height shifted out from under the animation).
//
// The component queries `.cm-scroller` out of the DOM rather than
// taking a ref, because the harness loads the editor lazily and we
// don't want to couple this diagnostic to the editor's internals.
// Bails cleanly if the scroller hasn't mounted yet.

interface Snapshot {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface VisibleLineInfo {
  text: string;
  cls: string;
  topOffset: number; // px from the top of the viewport
  height: number;
}

interface HeightEvent {
  at: number; // ms since observer started
  scrollTop: number;
  prevHeight: number;
  nextHeight: number;
  delta: number;
  // Absolute scrollTop velocity in px/s at the moment of the delta,
  // averaged over the last ~100ms. Useful context, but the real
  // filter is `causedHalt` below.
  velocity: number;
  // Set true when a halt was detected within HALT_ATTRIBUTION_MS
  // after this delta. That's the signature we actually care about —
  // scrollHeight changed AND iOS momentum stopped shortly after.
  // Deltas without a trailing halt are heightmap noise and don't
  // contribute to the user's scroll-stop experience.
  causedHalt: boolean;
  viewportSample: VisibleLineInfo[];
}

// Only capture a viewport sample when the height delta is big enough
// to matter. Tiny jitter from caret / focus changes otherwise floods
// the log. 32px is roughly a line's worth; anything smaller is noise.
const SAMPLE_THRESHOLD_PX = 32;

// Velocity averaging window. Too short and the number bobs around
// with every rAF; too long and we'd miss the edges of a fast flick.
const VELOCITY_WINDOW_MS = 100;

// A halt is detected when the scroller transitions from moving fast
// to nearly still within one rAF: previous-frame velocity above
// `HALT_PRIOR_VELOCITY_PX_PER_S` and current-frame velocity below
// `HALT_REST_VELOCITY_PX_PER_S`. These thresholds separate the sharp
// iOS momentum abort we're hunting from a natural flick coasting to
// a stop (which decelerates gradually through the middle range).
const HALT_PRIOR_VELOCITY_PX_PER_S = 200;
const HALT_REST_VELOCITY_PX_PER_S = 30;

// How far back to attribute a halt to prior Δh events. The iOS abort
// is reactive: scrollHeight moves, then the animation freezes within
// a frame or two. 200ms covers that cycle with margin for rAF jitter
// without sweeping in unrelated deltas.
const HALT_ATTRIBUTION_MS = 200;

function sampleVisibleLines(
  scroller: HTMLElement,
  limit: number,
): VisibleLineInfo[] {
  const scrollerRect = scroller.getBoundingClientRect();
  const lines = Array.from(
    scroller.querySelectorAll<HTMLElement>('.cm-line'),
  );
  const visible: VisibleLineInfo[] = [];
  for (const line of lines) {
    const rect = line.getBoundingClientRect();
    // Only keep lines that overlap the scroller's visible box.
    if (rect.bottom < scrollerRect.top) continue;
    if (rect.top > scrollerRect.bottom) break;
    visible.push({
      text: (line.textContent ?? '').slice(0, 50),
      cls: line.className.replace(/\bcm-line\b/, '').trim(),
      topOffset: Math.round(rect.top - scrollerRect.top),
      height: Math.round(rect.height),
    });
    if (visible.length >= limit) break;
  }
  return visible;
}

function useScrollerDiagnostics(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<HeightEvent[]>([]);
  const [haltCount, setHaltCount] = useState(0);
  const scrollerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setEvents([]);
      setHaltCount(0);
      return;
    }

    const start = performance.now();
    let lastHeight = 0;
    let rafId: number | null = null;
    // Rolling window of scrollTop observations for velocity math.
    // Entries outside VELOCITY_WINDOW_MS are trimmed each tick.
    const scrollTopHistory: { t: number; top: number }[] = [];
    // One-shot latch: once a halt transition is detected, wait for
    // velocity to rise again before arming the detector — otherwise
    // every frame of a prolonged low-velocity idle would trip it.
    let prevVelocity = 0;
    let haltArmed = false;

    const findScroller = (): HTMLElement | null => {
      return document.querySelector<HTMLElement>('.cm-scroller');
    };

    const currentVelocity = (now: number): number => {
      const cutoff = now - VELOCITY_WINDOW_MS;
      while (
        scrollTopHistory.length > 1 &&
        scrollTopHistory[0].t < cutoff
      ) {
        scrollTopHistory.shift();
      }
      if (scrollTopHistory.length < 2) return 0;
      const first = scrollTopHistory[0];
      const last = scrollTopHistory[scrollTopHistory.length - 1];
      const dt = last.t - first.t;
      if (dt <= 0) return 0;
      return Math.abs(((last.top - first.top) / dt) * 1000);
    };

    const tick = () => {
      rafId = null;
      const el = scrollerRef.current ?? findScroller();
      if (!el) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      scrollerRef.current = el;

      const nowT = performance.now() - start;
      const snap: Snapshot = {
        t: nowT,
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: Math.round(el.scrollHeight),
        clientHeight: Math.round(el.clientHeight),
      };
      scrollTopHistory.push({ t: nowT, top: snap.scrollTop });
      setSnapshot(snap);

      const velocity = currentVelocity(nowT);

      if (lastHeight !== 0 && snap.scrollHeight !== lastHeight) {
        const delta = snap.scrollHeight - lastHeight;
        const viewportSample =
          Math.abs(delta) >= SAMPLE_THRESHOLD_PX
            ? sampleVisibleLines(el, 12)
            : [];
        setEvents((prev) => {
          const next: HeightEvent = {
            at: Math.round(snap.t),
            scrollTop: snap.scrollTop,
            prevHeight: lastHeight,
            nextHeight: snap.scrollHeight,
            delta,
            velocity: Math.round(velocity),
            causedHalt: false,
            viewportSample,
          };
          // Keep the log bounded; oldest events drop off the front.
          const bounded = [...prev, next];
          if (bounded.length > 40) bounded.splice(0, bounded.length - 40);
          return bounded;
        });
      }
      lastHeight = snap.scrollHeight;

      // Arm the halt detector once velocity climbs into flick range.
      if (prevVelocity >= HALT_PRIOR_VELOCITY_PX_PER_S) haltArmed = true;

      if (
        haltArmed &&
        prevVelocity >= HALT_PRIOR_VELOCITY_PX_PER_S &&
        velocity <= HALT_REST_VELOCITY_PX_PER_S
      ) {
        // Halt transition! Walk back through recent events and tag
        // every Δh within HALT_ATTRIBUTION_MS as the likely cause.
        // Multiple preceding deltas within the window all get
        // credit — halts are usually preceded by a tight cluster
        // (shrink-then-correct or similar), and we don't know which
        // one iOS considered the trigger.
        const cutoff = Math.round(snap.t) - HALT_ATTRIBUTION_MS;
        setEvents((prev) =>
          prev.map((e) =>
            !e.causedHalt && e.at >= cutoff ? { ...e, causedHalt: true } : e,
          ),
        );
        setHaltCount((c) => c + 1);
        haltArmed = false;
      } else if (velocity < HALT_REST_VELOCITY_PX_PER_S) {
        // Already stopped — disarm so the detector only fires once
        // per flick-then-halt cycle, not every frame the scroller
        // sits idle at low velocity afterward.
        haltArmed = false;
      }

      prevVelocity = velocity;

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [enabled]);

  return { snapshot, events, haltCount };
}

function formatDelta(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n}`;
}

export function ScrollDiagnostics() {
  const [enabled, setEnabled] = useState(false);
  const [expandedAt, setExpandedAt] = useState<number | null>(null);
  // `haltsOnly` filters both the histogram and the events table to
  // deltas that were actually followed by a halt transition (iOS
  // momentum abort). Events without a trailing halt are heightmap
  // noise — harmless — and polluted the earlier velocity-based
  // filter with false positives.
  const [haltsOnly, setHaltsOnly] = useState(true);
  const { snapshot, events, haltCount } = useScrollerDiagnostics(enabled);

  const shownEvents = useMemo(() => {
    if (!haltsOnly) return events;
    return events.filter((e) => e.causedHalt);
  }, [events, haltsOnly]);

  // Aggregate class frequencies across captured delta events. Each
  // `.cm-line` in a sample contributes a count per non-trivial class
  // it carries; totals form a baseline for interpreting ratios.
  // Respects the activeOnly filter so the histogram only reflects
  // deltas that coincide with momentum scrolling — idle deltas get
  // excluded.
  const classSummary = useMemo(() => {
    const counts = new Map<string, number>();
    let totalLines = 0;
    for (const e of shownEvents) {
      for (const line of e.viewportSample) {
        totalLines++;
        const classes = line.cls.split(/\s+/).filter(Boolean);
        // Group unclassed lines (plain paragraphs, typing-only) as
        // `plain` so the histogram has a baseline to compare against.
        if (classes.length === 0) {
          counts.set('(plain)', (counts.get('(plain)') ?? 0) + 1);
          continue;
        }
        for (const c of classes) {
          if (c === 'cm-activeLine') continue;
          counts.set(c, (counts.get(c) ?? 0) + 1);
        }
      }
    }
    return {
      totalLines,
      entries: Array.from(counts.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [shownEvents]);

  const clearEvents = () => {
    // The hook's events state is owned internally; cheapest way to
    // reset without plumbing a setter back out is to flip `enabled`
    // off and on, which restarts the observer with an empty log.
    setEnabled(false);
    requestAnimationFrame(() => setEnabled(true));
  };

  return (
    <div
      className="pointer-events-none fixed bottom-2 right-2 z-50 max-w-[min(420px,90vw)] text-[11px]"
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    >
      <div className="pointer-events-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-panel)] p-2 shadow-lg">
        <div className="mb-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={
              'rounded border px-2 py-0.5 text-[10px] transition-colors ' +
              (enabled
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-alpha)] text-[var(--color-text-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-secondary)]')
            }
          >
            {enabled ? 'scroll diag: on' : 'scroll diag: off'}
          </button>
          {enabled && (
            <>
              <button
                type="button"
                onClick={() => setHaltsOnly((v) => !v)}
                className={
                  'rounded border px-2 py-0.5 text-[10px] transition-colors ' +
                  (haltsOnly
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-alpha)] text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)]')
                }
                title="When on, only show deltas that were followed by a scroll halt (sharp velocity drop within 200ms)."
              >
                {haltsOnly ? 'halts only' : 'all deltas'}
              </button>
              <span className="text-[10px] text-[var(--color-text-secondary)]">
                halts: <span className="text-[var(--color-text-primary)]">{haltCount}</span>
              </span>
              <button
                type="button"
                onClick={clearEvents}
                className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-border-hover)]"
              >
                clear
              </button>
            </>
          )}
        </div>

        {enabled && snapshot && (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[var(--color-text-secondary)]">
              <span>scrollTop</span>
              <span className="text-right text-[var(--color-text-primary)]">
                {snapshot.scrollTop}
              </span>
              <span>scrollHeight</span>
              <span className="text-right text-[var(--color-text-primary)]">
                {snapshot.scrollHeight}
              </span>
              <span>clientHeight</span>
              <span className="text-right text-[var(--color-text-primary)]">
                {snapshot.clientHeight}
              </span>
              <span>top / height</span>
              <span className="text-right text-[var(--color-text-primary)]">
                {snapshot.scrollHeight > 0
                  ? (
                      (100 * snapshot.scrollTop) /
                      Math.max(1, snapshot.scrollHeight - snapshot.clientHeight)
                    ).toFixed(1) + '%'
                  : '—'}
              </span>
            </div>

            {classSummary.entries.length > 0 && (
              <div className="mt-2 border-t border-[var(--color-border)] pt-1">
                <div className="mb-1 flex justify-between text-[10px] text-[var(--color-text-secondary)]">
                  <span>classes in deltas</span>
                  <span>{classSummary.totalLines} lines</span>
                </div>
                <div className="space-y-0.5">
                  {classSummary.entries.slice(0, 10).map(([cls, n]) => {
                    const pct = (100 * n) / Math.max(1, classSummary.totalLines);
                    return (
                      <div
                        key={cls}
                        className="flex items-center gap-2 text-[10px] font-mono"
                      >
                        <span className="w-8 text-right text-[var(--color-text-tertiary)]">
                          {n}
                        </span>
                        <span className="w-8 text-right text-[var(--color-text-secondary)]">
                          {pct.toFixed(0)}%
                        </span>
                        <span className="flex-1 truncate text-[var(--color-accent-light)]">
                          {cls.replace(/^cm-atomic-/, '')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-2 border-t border-[var(--color-border)] pt-1">
              <div className="mb-1 flex justify-between text-[10px] text-[var(--color-text-secondary)]">
                <span>height changes</span>
                <span>
                  {shownEvents.length}
                  {haltsOnly && events.length > shownEvents.length && (
                    <span className="text-[var(--color-text-tertiary)]">
                      {' '}
                      / {events.length}
                    </span>
                  )}
                </span>
              </div>
              <div className="max-h-[200px] overflow-y-auto">
                {shownEvents.length === 0 ? (
                  <div className="py-1 text-center text-[10px] text-[var(--color-text-tertiary)]">
                    {haltsOnly
                      ? '(flick-scroll — a halt will flag its cause here)'
                      : '(scroll and watch for deltas)'}
                  </div>
                ) : (
                  <table className="w-full border-collapse text-[10px]">
                    <thead className="sticky top-0 bg-[var(--color-bg-panel)] text-[var(--color-text-secondary)]">
                      <tr>
                        <th className="text-left font-normal">t (ms)</th>
                        <th className="text-right font-normal">v</th>
                        <th className="text-right font-normal">top</th>
                        <th className="text-right font-normal">Δh</th>
                        <th className="text-right font-normal">h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownEvents
                        .slice()
                        .reverse()
                        .map((e, i) => {
                          const hasSample = e.viewportSample.length > 0;
                          const expanded = expandedAt === e.at;
                          return (
                            <Fragment key={`${e.at}-${i}`}>
                              <tr
                                className={
                                  'border-t border-[var(--color-border)]/40 ' +
                                  (e.causedHalt
                                    ? 'bg-[var(--color-danger,#f87171)]/10 '
                                    : '') +
                                  (hasSample ? 'cursor-pointer hover:bg-[var(--color-bg-card)]/60' : '')
                                }
                                onClick={() => {
                                  if (!hasSample) return;
                                  setExpandedAt(expanded ? null : e.at);
                                }}
                              >
                                <td className="py-0.5 text-[var(--color-text-tertiary)]">
                                  {hasSample ? (expanded ? '▾ ' : '▸ ') : ''}
                                  {e.causedHalt ? '🛑 ' : ''}
                                  {e.at}
                                </td>
                                <td className="py-0.5 text-right text-[var(--color-text-tertiary)]">
                                  {e.velocity}
                                </td>
                                <td className="py-0.5 text-right text-[var(--color-text-primary)]">
                                  {e.scrollTop}
                                </td>
                                <td
                                  className={
                                    'py-0.5 text-right font-semibold ' +
                                    (e.delta > 0
                                      ? 'text-[var(--color-accent-light)]'
                                      : 'text-[var(--color-danger,#f87171)]')
                                  }
                                >
                                  {formatDelta(e.delta)}
                                </td>
                                <td className="py-0.5 text-right text-[var(--color-text-secondary)]">
                                  {e.nextHeight}
                                </td>
                              </tr>
                              {expanded && hasSample && (
                                <tr className="bg-[var(--color-bg-card)]/40">
                                  <td colSpan={5} className="px-1 py-1">
                                    <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">
                                      viewport sample ({e.viewportSample.length} lines):
                                    </div>
                                    <div className="space-y-0.5">
                                      {e.viewportSample.map((l, j) => (
                                        <div
                                          key={j}
                                          className="flex gap-2 text-[10px] font-mono"
                                        >
                                          <span className="w-8 text-right text-[var(--color-text-tertiary)]">
                                            {l.topOffset}
                                          </span>
                                          <span className="w-7 text-right text-[var(--color-text-tertiary)]">
                                            h{l.height}
                                          </span>
                                          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--color-text-primary)]">
                                            {l.text || '(empty)'}
                                          </span>
                                          {l.cls && (
                                            <span className="text-[var(--color-accent-light)]">
                                              {l.cls}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
