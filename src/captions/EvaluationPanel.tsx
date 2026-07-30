import { useMemo, useState } from 'react';
import type {
  EvaluationFlag,
  EvaluationRating,
  EvaluationResult,
} from './types';

type Candidate = EvaluationResult['primary'] | Exclude<EvaluationResult['shadow'], null | { error: string }>;
type VisibleChoice = 'a' | 'b' | 'tie' | 'skip';
type RatingDraft = {
  semanticScore: number | null;
  flags: EvaluationFlag[];
  notes: string;
};

const QUALITY_FLAGS: Array<{ value: EvaluationFlag; label: string }> = [
  { value: 'wrong-language', label: 'Wrong language' },
  { value: 'omission', label: 'Material omission' },
  { value: 'hallucination', label: 'Added meaning' },
  { value: 'number-unit-id', label: 'Number / unit / ID' },
  { value: 'terminology', label: 'Terminology' },
  { value: 'late', label: 'Too late' },
  { value: 'flutter', label: 'Distracting reversal' },
  { value: 'duplicate', label: 'Duplicate' },
];

function hasShadow(
  result: EvaluationResult,
): result is EvaluationResult & {
  shadow: Exclude<EvaluationResult['shadow'], null | { error: string }>;
} {
  return Boolean(result.shadow && !('error' in result.shadow));
}

function ResultCard({
  label,
  candidate,
  revealProfile,
}: {
  label: 'A' | 'B';
  candidate: Candidate;
  revealProfile: boolean;
}) {
  return (
    <article className="result-card">
      <header>
        <strong>Candidate {label}</strong>
        <span>
          {revealProfile ? `${candidate.profile} · ` : ''}
          {candidate.latencyMs.toLocaleString()} ms
        </span>
      </header>
      <p lang="en">{candidate.english || 'Translation unavailable'}</p>
      <p lang="zh-Hans">{candidate.chinese || '翻译暂不可用'}</p>
    </article>
  );
}

function signalLabels(result: EvaluationResult) {
  const labels: string[] = [];
  if (result.signals.mixedSource) labels.push('Mixed-language source');
  if (result.signals.wrongAudienceLanguage.en) labels.push('English output script mismatch');
  if (result.signals.wrongAudienceLanguage.zh) labels.push('Chinese output script mismatch');
  const missing = [
    ...result.signals.missingProtectedTokens.en,
    ...result.signals.missingProtectedTokens.zh,
  ];
  if (missing.length) labels.push(`Protected token check: ${[...new Set(missing)].join(', ')}`);
  if (result.signals.fastPathDivergence) labels.push('Same-language fast path diverged');
  return labels;
}

export function EvaluationPanel({ results }: { results: EvaluationResult[] }) {
  const [ratings, setRatings] = useState<Record<number, EvaluationRating>>({});
  const [drafts, setDrafts] = useState<Record<number, RatingDraft>>({});
  const [pending, setPending] = useState<number | null>(null);

  const summary = useMemo(() => {
    const paired = results.filter(hasShadow);
    const choices = Object.values(ratings).reduce<Record<string, number>>(
      (counts, rating) => {
        counts[rating.preference] = (counts[rating.preference] || 0) + 1;
        return counts;
      },
      {},
    );
    if (!paired.length) return null;
    return {
      count: paired.length,
      primary: Math.round(
        paired.reduce((sum, result) => sum + result.primary.latencyMs, 0) /
          paired.length,
      ),
      shadow: Math.round(
        paired.reduce((sum, result) => sum + result.shadow.latencyMs, 0) /
          paired.length,
      ),
      rated: Object.keys(ratings).length,
      choices,
    };
  }, [ratings, results]);

  const rate = async (
    result: EvaluationResult,
    choice: VisibleChoice,
    primaryIsA: boolean,
  ) => {
    const preference =
      choice === 'tie' || choice === 'skip'
        ? choice
        : (choice === 'a') === primaryIsA
          ? 'primary'
          : 'shadow';
    const draft = drafts[result.sequence] || {
      semanticScore: null,
      flags: [],
      notes: '',
    };
    setPending(result.sequence);
    const response = await window.captions.rateEvaluation({
      sequence: result.sequence,
      preference,
      semanticScore: draft.semanticScore,
      flags: draft.flags,
      notes: draft.notes,
    });
    setPending(null);
    if (response.ok) {
      setRatings((current) => ({
        ...current,
        [result.sequence]: response.data,
      }));
    }
  };

  return (
    <section className="panel-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">BLINDED LIVE A/B</p>
          <h2>Choose what reads better before seeing the profile</h2>
        </div>
        {summary && (
          <p className="comparison-summary" aria-live="polite">
            {summary.rated}/{summary.count} rated · average latency{' '}
            {summary.primary}/{summary.shadow} ms
          </p>
        )}
      </div>
      <p className="supporting-copy">
        A and B swap positions between lines to reduce position bias. Only the
        primary result reaches the audience overlays; the shadow remains in this
        private review panel.
      </p>
      {results.length === 0 ? (
        <div className="empty-state">
          No developer comparison results are available for this session.
        </div>
      ) : (
        <div className="evaluation-list">
          {[...results].reverse().map((result) => {
            const primaryIsA = result.sequence % 2 === 1;
            const rating = ratings[result.sequence];
            const signals = signalLabels(result);
            const draft = drafts[result.sequence] || {
              semanticScore: null,
              flags: [],
              notes: '',
            };
            const updateDraft = (patch: Partial<RatingDraft>) =>
              setDrafts((current) => ({
                ...current,
                [result.sequence]: { ...draft, ...patch },
              }));
            return (
              <article className="evaluation-row" key={`${result.sessionId}-${result.sequence}`}>
                <div className="evaluation-source">
                  <span>
                    #{result.sequence} · {result.sourceChannel}
                    {result.screeningPrompt
                      ? ` · ${result.screeningPrompt.id}`
                      : ''}
                  </span>
                  <p>{result.sourceText}</p>
                </div>
                {hasShadow(result) ? (
                  <>
                    <div className="result-grid">
                      <ResultCard
                        label="A"
                        candidate={primaryIsA ? result.primary : result.shadow}
                        revealProfile={Boolean(rating)}
                      />
                      <ResultCard
                        label="B"
                        candidate={primaryIsA ? result.shadow : result.primary}
                        revealProfile={Boolean(rating)}
                      />
                    </div>
                    <details className="quality-review">
                      <summary>Quality score and failure flags</summary>
                      <div className="quality-review__body">
                        <label className="field">
                          <span>Semantic accuracy</span>
                          <select
                            disabled={Boolean(rating)}
                            value={draft.semanticScore ?? ''}
                            onChange={(event) =>
                              updateDraft({
                                semanticScore: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              })
                            }
                          >
                            <option value="">Not scored</option>
                            {[1, 2, 3, 4, 5].map((score) => (
                              <option value={score} key={score}>
                                {score} / 5
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="quality-flags" aria-label="Failure flags">
                          {QUALITY_FLAGS.map((flag) => (
                            <label className="toggle toggle--compact" key={flag.value}>
                              <input
                                type="checkbox"
                                disabled={Boolean(rating)}
                                checked={draft.flags.includes(flag.value)}
                                onChange={(event) =>
                                  updateDraft({
                                    flags: event.target.checked
                                      ? [...draft.flags, flag.value]
                                      : draft.flags.filter(
                                          (value) => value !== flag.value,
                                        ),
                                  })
                                }
                              />
                              <span>{flag.label}</span>
                            </label>
                          ))}
                        </div>
                        <label className="field">
                          <span>Optional note</span>
                          <input
                            type="text"
                            disabled={Boolean(rating)}
                            maxLength={500}
                            value={draft.notes}
                            onChange={(event) =>
                              updateDraft({ notes: event.target.value })
                            }
                          />
                        </label>
                      </div>
                    </details>
                    <div className="judgement-row" aria-label={`Rate caption ${result.sequence}`}>
                      {(['a', 'tie', 'b', 'skip'] as VisibleChoice[]).map((choice) => (
                        <button
                          className={rating ? 'is-rated' : ''}
                          disabled={pending === result.sequence || Boolean(rating)}
                          key={choice}
                          onClick={() => void rate(result, choice, primaryIsA)}
                        >
                          {choice === 'a'
                            ? 'A reads better'
                            : choice === 'b'
                              ? 'B reads better'
                              : choice === 'tie'
                                ? 'Tie'
                                : 'Skip'}
                        </button>
                      ))}
                      {rating && <span className="rating-confirmation">Saved · profiles revealed</span>}
                    </div>
                  </>
                ) : (
                  <div className="result-card result-card--muted">
                    Shadow comparison unavailable for this line.
                  </div>
                )}
                <details className="diagnostic-details">
                  <summary>Diagnostic evidence</summary>
                  <div className="diagnostic-grid">
                    <span>Transcript {result.stageLatency.transcriptionMs} ms</span>
                    <span>Ordering {result.stageLatency.reorderMs} ms</span>
                    <span>Normalization {result.stageLatency.normalizationMs} ms</span>
                    <span>End-to-end {result.stageLatency.endToEndMs} ms</span>
                  </div>
                  <p>{signals.length ? signals.join(' · ') : 'Automated checks passed'}</p>
                </details>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
