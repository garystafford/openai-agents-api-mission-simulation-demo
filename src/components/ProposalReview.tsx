import { useState } from "react";

export function ProposalReview({
  blocked,
  authorize,
  ask,
}: {
  blocked: boolean;
  authorize: () => void;
  ask: (request: string) => Promise<void>;
}) {
  const [request, setRequest] = useState("");
  return (
    <>
      <p className="eyebrow">Response plan ready</p>
      <h2>Ready for your decision</h2>
      <p className="muted">
        Review the proposed actions, then continue to authorization. Execution starts only after you
        confirm.
      </p>
      <button className="affirmative" onClick={authorize} disabled={blocked}>
        Review and authorize plan
      </button>
      <details className="optional-plan-review">
        <summary>Ask about or revise this plan</summary>
        <p className="muted">
          Ask about an assumption or request a different response. This starts another assessment
          using this mission’s context. Simulation time stays frozen, and any revised plan still
          needs your authorization.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && request.trim()) void ask(request.trim());
          }}
        >
          <label className="review-question">
            <span>Question or requested revision</span>
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="For example: What happens if the backup relay never comes online?"
              maxLength={4000}
              required
              disabled={blocked}
            />
          </label>
          <button type="submit" className="secondary" disabled={blocked || !request.trim()}>
            Send to Director
          </button>
        </form>
      </details>
    </>
  );
}
