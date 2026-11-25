/** Diagnostic + topic record types for `cuthol explain`. */

export interface DiagnosticThresholdRef {
  /** OPEN_STANDARDS path, e.g. "LOUDNESS.DEFAULT_TRUE_PEAK_DBTP". */
  key: string;
}

export interface DiagnosticNoThreshold {
  none: true;
  why: string;
}

export type DiagnosticThreshold = DiagnosticThresholdRef | DiagnosticNoThreshold;

export interface DiagnosticDoc {
  /** Short code without prefix, e.g. "G512". */
  code: string;
  title: string;
  /** What value/expression the check compares. */
  checks: string;
  /** Exact condition under which the diagnostic fires. */
  fires_when: string;
  /** File + function where the check runs. */
  source: string;
  severity: string;
  gate: string;
  /** Message template shape with ${...} placeholders. */
  messageShape: string;
  thresholds: DiagnosticThreshold[];
  /** Runnable cuthol commands or concrete steps. */
  fix: string[];
  /** Skill file + section, if any. */
  see?: string;
}

export interface TopicDoc {
  topic: string;
  title: string;
  body: string;
  /** File the behaviour is derived from. */
  see: string;
}
