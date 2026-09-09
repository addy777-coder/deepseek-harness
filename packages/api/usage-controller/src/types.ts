/** Shared usage statistics returned by the Host and retained by the Client. */

/** Calendar range and IANA time zone selected by the viewer. */
export interface UsageRequest {
  days: 7 | 30
  timeZone: string
}

/** Exact reported tokens attributed to one provider and model. Empty names mean unavailable attribution. */
export interface UsageModel {
  provider: string
  model: string
  tokens: number
}

/** One local calendar date, including dates without recorded activity. */
export interface UsageDay {
  date: string
  tokens: number
  messages: number
  sessions: number
  models: UsageModel[]
}

/** Top-level user messages on a local calendar date. */
export interface UsageHeatmapDay {
  date: string
  messages: number
}

/** Overview for the selected interval; the streak spans all available history. */
export interface UsageSummary {
  totalTokens: number
  sessionCount: number
  messageCount: number
  activeDays: number
  currentStreak: number
  mostUsedModel: UsageModel | null
}

/** Detached statistics over every readable live or persisted session in this Harness home. */
export interface UsageSnapshot {
  days: 7 | 30
  timeZone: string
  /** Inclusive local date in YYYY-MM-DD format. */
  from: string
  /** Inclusive local date in YYYY-MM-DD format. */
  to: string
  /** Request observation time in Unix epoch milliseconds. */
  generatedAt: number
  summary: UsageSummary
  daily: UsageDay[]
  models: UsageModel[]
  /** Exactly 365 consecutive dates ending today. */
  heatmap: UsageHeatmapDay[]
  coverage: {
    /** Session reads that failed, independently of the selected interval. */
    unreadableSessions: number
    /** Recorded attempts without exact usage in the selected interval. */
    missingUsageAttempts: number
  }
}
