/** Local calendar dates independent of elapsed-day lengths and Host time zone. */

/**
 * Build a formatter that also validates the requested IANA time zone.
 * @param timeZone - viewer time zone.
 * @returns a stable ISO-calendar date formatter.
 */
export function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
}

/**
 * Assign one event to its local calendar date.
 * @param formatter - validated viewer-local formatter.
 * @param time - event time in Unix epoch milliseconds.
 * @returns a date in YYYY-MM-DD format.
 */
export function dateOf(formatter: Intl.DateTimeFormat, time: number): string {
  const parts = formatter.formatToParts(time)
  // oxlint-disable-next-line typescript/no-non-null-assertion -- this formatter requests all three ISO date fields
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/**
 * Move a civil date without assuming every local day lasts 24 hours.
 * @param date - ISO calendar date.
 * @param days - signed calendar-day displacement.
 * @returns the displaced ISO calendar date.
 */
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
