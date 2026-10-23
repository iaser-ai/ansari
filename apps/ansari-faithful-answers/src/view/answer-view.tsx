import type {CardChromeProps} from '@saga-a2ui/react-mcp-stack/faithful-card';
import {useLayoutEffect, useRef} from 'react';
import {SagaCredit} from './saga-credit.js';
import {BRANDING} from './branding.js';
import {watchAttribution} from './attribution.js';

// The application's chrome around the shared card (the stack's `chrome` option). It supplies the
// question header and the footer treatment (data-attribution -> theme.css); the answer itself is the
// card's, which the stack places here exactly once. The footer mark is taken from the paragraph the
// card rendered and marked as its closing block (attribution.ts), never from a second reading of the
// Markdown. It chooses no artwork, no policy and no text of an answer: artwork and colors are the
// app's constants (floral-artwork.ts, theme.css, both loaded by the composition root).

export function AnswerView({card, state}: CardChromeProps) {
  const article = useRef<HTMLElement>(null);
  const showingAnswer = state.kind === 'answer';
  useLayoutEffect(() => (article.current === null ? undefined : watchAttribution(article.current)), [showingAnswer]);
  return (
    <main>
      {state.kind === 'answer' ? (
        <article ref={article} className="answer-card" data-testid="answer-card">
          <header className="answer-header">
            {state.heading === undefined || state.heading === '' ? null : (
              <h2 className="answer-question" dir="auto" data-testid="question">
                {state.heading}
              </h2>
            )}
          </header>
          {card}
          <SagaCredit enabled={BRANDING.showSagaCredit} />
        </article>
      ) : null}
      <p className="answer-status" role="status" data-testid="answer-status">
        {state.kind === 'answer' ? '' : state.text}
      </p>
    </main>
  );
}
