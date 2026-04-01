import { SeverityNumber } from "@opentelemetry/api-logs";
import { loggerProvider } from "@/instrumentation";

const otelLogger = loggerProvider.getLogger("pagealert");

type LogAttributes = Record<string, string | number | boolean | undefined>;

function emit(
  severity: SeverityNumber,
  message: string,
  attributes?: LogAttributes
) {
  // Filter out undefined values
  const clean: Record<string, string | number | boolean> = {};
  if (attributes) {
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) clean[k] = v;
    }
  }

  otelLogger.emit({
    body: message,
    severityNumber: severity,
    attributes: clean,
  });
}

export const logger = {
  info(message: string, attributes?: LogAttributes) {
    emit(SeverityNumber.INFO, message, attributes);
  },

  warn(message: string, attributes?: LogAttributes) {
    emit(SeverityNumber.WARN, message, attributes);
  },

  error(message: string, attributes?: LogAttributes) {
    emit(SeverityNumber.ERROR, message, attributes);
  },

  debug(message: string, attributes?: LogAttributes) {
    emit(SeverityNumber.DEBUG, message, attributes);
  },

  /** Call in route handlers to ensure logs are sent before serverless freeze */
  async flush() {
    await loggerProvider.forceFlush();
  },
};
