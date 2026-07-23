/**
 * Centralized business timezone for the MilaServ Portal.
 *
 * The company operates in Saudi Arabia (SAR pricing, KSA branch network), so
 * every business-facing timestamp — order/complaint activity timelines,
 * call-center day/hour buckets, dashboard date windows — is expressed in
 * Asia/Riyadh. Keeping the zone in one place prevents the drift that previously
 * had the order/complaint timelines formatted in Africa/Cairo (UTC+2) while the
 * call-center analytics bucketed in UTC+3.
 *
 * This governs how UTC timestamps are *displayed / bucketed*; it does not change
 * how timestamps are stored. Database rows remain UTC.
 */

/** IANA zone used for `Intl.DateTimeFormat` and any date display. */
export const BUSINESS_TIMEZONE = "Asia/Riyadh" as const;

/**
 * Fixed UTC offset (in minutes) for {@link BUSINESS_TIMEZONE}. Asia/Riyadh is
 * UTC+3 year-round (no DST), so a constant offset is exact. It backs the
 * epoch-based day/hour bucketing in the Yeastar CDR pipeline, where offset math
 * (not IANA formatting) is required. Deployments may still override it via the
 * `YEASTAR_UTC_OFFSET_MINUTES` environment variable.
 */
export const BUSINESS_UTC_OFFSET_MINUTES = 180;
