import { useMemo } from 'react';
import type { EvaluationResult } from './types';

function ResultCard({
  label,
  profile,
  english,
  chinese,
  latencyMs,
}: {
  label: string;
  profile: string;
  english: string;
  chinese: string;
  latencyMs: number;
}) {
  return (
    <article className="result-card">
      <header>
        <strong>{label}</strong>
        <span>{profile} · {latencyMs.toLocaleString()} ms</span>
      </header>
      <p lang="en">{english || 'Translation unavailable'}</p>
      <p lang="zh-Hans">{chinese || '翻译暂不可用'}</p>
    </article>
  );
}

export function EvaluationPanel({ results }: { results: EvaluationResult[] }) {
  const summary = useMemo(() => {
    const paired = results.filter((result) => result.shadow && !('error' in result.shadow));
    if (!paired.length) return null;
    return {
      count: paired.length,
      primary: Math.round(
        paired.reduce((sum, result) => sum + result.primary.latencyMs, 0) /
          paired.length,
      ),
      shadow: Math.round(
        paired.reduce(
          (sum, result) =>
            sum +
            (result.shadow && !('error' in result.shadow)
              ? result.shadow.latencyMs
              : 0),
          0,
        ) / paired.length,
      ),
    };
  }, [results]);

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">LIVE A/B</p>
          <h2>Compare the foundation in a real meeting</h2>
        </div>
        {summary && (
          <p className="comparison-summary">
            {summary.count} paired lines · median-like average {summary.primary} / {summary.shadow} ms
          </p>
        )}
      </div>
      <p className="supporting-copy">
        Both profiles receive the same final transcript. Only the primary result is
        sent to the audience overlays; the shadow stays here for judgement.
      </p>
      {results.length === 0 ? (
        <div className="empty-state">
          Start Demo Session for an immediate walkthrough, or start a live session
          with comparison enabled.
        </div>
      ) : (
        <div className="evaluation-list">
          {[...results].reverse().map((result) => (
            <article className="evaluation-row" key={`${result.sessionId}-${result.sequence}`}>
              <div className="evaluation-source">
                <span>#{result.sequence} · {result.sourceChannel}</span>
                <p>{result.sourceText}</p>
              </div>
              <div className="result-grid">
                <ResultCard label="PRIMARY" {...result.primary} />
                {result.shadow && !('error' in result.shadow) ? (
                  <ResultCard label="SHADOW" {...result.shadow} />
                ) : (
                  <div className="result-card result-card--muted">
                    Shadow comparison unavailable for this line.
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
