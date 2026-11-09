/**
 * Pure predicate behind the sidebar's DevLead Session-row mark.
 *
 * The mark must render for every listed Session, including cold rows the client
 * never attached. The digest-bearing `devLead` projection is deliberately
 * excluded from Session summaries, so the row reads the summary-sized
 * `devLeadMode` value instead: `SessionSummary.projectionValues` carries it on
 * every list pull. This module keeps that read testable without React.
 *
 * The input is a structural shape rather than the full `SessionSummary` type:
 * the component passes the list row straight through, and the predicate only
 * needs the one projection value.
 */

/** Structural view of the row's summary projection values this mark reads. */
export interface DevLeadRowSummary {
  /** Summary projection values carried by one Session list row. */
  readonly projectionValues?: {
    /** Summary-sized DevLead mode selection, when the Host published it. */
    readonly devLeadMode?: { readonly enabled?: boolean }
  }
}

/**
 * Whether one listed Session row should render the DevLead mark.
 * @param summary - the row's Session summary, or undefined before the list lands.
 * @returns true only when the summary explicitly reports DevLead mode enabled.
 */
export function devLeadRowEnabled(summary: DevLeadRowSummary | undefined): boolean {
  return summary?.projectionValues?.devLeadMode?.enabled === true
}
