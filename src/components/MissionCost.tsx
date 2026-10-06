import type { MissionUsage } from "../../server/mission-contract.js";

const tokenFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function MissionCost({ usage }: { usage: MissionUsage }) {
  const estimatedCostUsd = usage.estimatedCostUsd;
  return (
    <section className="panel mission-cost">
      <div className="cost-heading">
        <div>
          <p className="eyebrow">Mission usage</p>
          <h2>Token and cost estimate</h2>
        </div>
        <strong>
          {estimatedCostUsd === undefined
            ? usage.accountingPending
              ? "Accounting pending"
              : "Unpriced"
            : currencyFormatter.format(estimatedCostUsd)}
        </strong>
      </div>
      <div className="cost-metrics">
        <div>
          <span>Input</span>
          <strong>{tokenFormatter.format(usage.inputTokens)}</strong>
        </div>
        <div>
          <span>Reasoning</span>
          <strong>{tokenFormatter.format(usage.reasoningTokens)}</strong>
        </div>
        <div>
          <span>Visible output</span>
          <strong>{tokenFormatter.format(usage.visibleOutputTokens)}</strong>
        </div>
        <div>
          <span>Agent turns</span>
          <strong>{usage.requests}</strong>
        </div>
      </div>
      <p className="cost-note">
        {tokenFormatter.format(usage.totalTokens)} total tokens ·{" "}
        {tokenFormatter.format(usage.cachedInputTokens)} cached input. Reasoning is included in
        output, not added twice.
      </p>
      {usage.accountingPending && (
        <p className="cost-warning">
          Usage accounting is still arriving. Counts shown are provisional.
        </p>
      )}
      {usage.unpricedModels.length > 0 ? (
        <p className="cost-warning">
          Add pricing overrides for {usage.unpricedModels.join(", ")} to calculate the full
          estimate.
        </p>
      ) : (
        <p className="cost-note">Estimated at standard direct-API token rates.</p>
      )}
      <details className="cost-breakdown">
        <summary>Model breakdown</summary>
        <ul>
          {usage.byModel.map((model) => (
            <li key={model.model}>
              <span>
                <strong>{model.model}</strong>
                {model.requests} turn{model.requests === 1 ? "" : "s"} ·{" "}
                {tokenFormatter.format(model.totalTokens)} tokens
              </span>
              <em>
                {model.estimatedCostUsd === undefined
                  ? "Pricing unavailable"
                  : currencyFormatter.format(model.estimatedCostUsd)}
              </em>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
