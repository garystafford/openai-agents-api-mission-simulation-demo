import { register } from "@arizeai/phoenix-otel";
import { trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import "./env.js";

export const phoenixTracingEnabled = process.env.PHOENIX_ENABLED === "true";
if (phoenixTracingEnabled) {
  register({
    projectName: process.env.PHOENIX_PROJECT_NAME ?? "mars-mission-control",
    url: process.env.PHOENIX_COLLECTOR_ENDPOINT,
    apiKey: process.env.PHOENIX_API_KEY,
    batch: true,
  });
}

// Application spans complement hosted traces. Secrets, tool arguments, and
// generated content are never included in application trace attributes.
export async function traceMissionOperation<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>
): Promise<T> {
  if (!phoenixTracingEnabled) return operation();
  return trace.getTracer("mars-agents-api").startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
