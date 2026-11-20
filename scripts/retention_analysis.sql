-- Monthly Retention Cohort Analysis
-- Cohort: Sponsors grouped by their month of first sponsorship
-- Metric: Percentage of sponsors active in each subsequent month

WITH cohort_data AS (
  SELECT
    sponsor_address,
    DATE_TRUNC('month', signup_date) AS signup_month
  FROM sponsor_signups
),
activity_data AS (
  SELECT
    sponsor_address,
    DATE_TRUNC('month', created_at) AS activity_month
  FROM sponsorships
),
cohort_sizes AS (
  SELECT
    signup_month,
    COUNT(sponsor_address) AS cohort_size
  FROM cohort_data
  GROUP BY signup_month
),
retention_data AS (
  SELECT
    c.signup_month,
    a.activity_month,
    COUNT(DISTINCT a.sponsor_address) AS active_sponsors
  FROM cohort_data c
  JOIN activity_data a ON c.sponsor_address = a.sponsor_address
  GROUP BY c.signup_month, a.activity_month
)
SELECT
  rd.signup_month,
  cs.cohort_size,
  rd.activity_month,
  rd.active_sponsors,
  ROUND((rd.active_sponsors::numeric / cs.cohort_size::numeric) * 100, 2) AS retention_rate
FROM retention_data rd
JOIN cohort_sizes cs ON rd.signup_month = cs.signup_month
ORDER BY rd.signup_month, rd.activity_month;

-- ============================================================================
-- Retention / Compaction Analysis
-- ============================================================================
-- These queries help operators verify that audit queries remain complete after
-- high-volume indexed events are compacted into archive summaries.
--
-- Expected schema (see docs/retention.md):
--   event_envelopes(id, retention_class, created_at, compacted_at, archived)
--   event_archive_summaries(id, retention_class, range_start, range_end,
--                           envelope_count, archived_at)
--
-- A "gap" is a time range where raw envelopes were compacted (compacted_at is
-- set) but no matching archive summary covers that range. Gaps indicate audit
-- queries may be incomplete and require operator attention / recovery.

-- ----------------------------------------------------------------------------
-- 1. Envelope counts by retention class
-- ----------------------------------------------------------------------------
-- Reports how many envelopes exist per retention class, split by lifecycle
-- state (raw, compacted, archived) so operators can see compaction progress.
SELECT
  retention_class,
  COUNT(*) AS total_envelopes,
  COUNT(*) FILTER (WHERE compacted_at IS NULL) AS raw_envelopes,
  COUNT(*) FILTER (WHERE compacted_at IS NOT NULL) AS compacted_envelopes,
  COUNT(*) FILTER (WHERE archived) AS archived_envelopes,
  MIN(created_at) AS oldest_envelope,
  MAX(created_at) AS newest_envelope
FROM event_envelopes
GROUP BY retention_class
ORDER BY retention_class;

-- ----------------------------------------------------------------------------
-- 2. Archive coverage per time range
-- ----------------------------------------------------------------------------
-- For each archive summary, report the covered range, the number of envelopes
-- it claims to summarize, and the number of raw envelopes still present in
-- that range. A summary whose archived count does not match the raw count in
-- its range is flagged for review.
WITH summary_coverage AS (
  SELECT
    s.id AS summary_id,
    s.retention_class,
    s.range_start,
    s.range_end,
    s.envelope_count AS archived_count,
    s.archived_at,
    COUNT(e.id) AS raw_count_in_range
  FROM event_archive_summaries s
  LEFT JOIN event_envelopes e
    ON e.retention_class = s.retention_class
   AND e.created_at >= s.range_start
   AND e.created_at < s.range_end
  GROUP BY
    s.id, s.retention_class, s.range_start, s.range_end,
    s.envelope_count, s.archived_at
)
SELECT
  summary_id,
  retention_class,
  range_start,
  range_end,
  archived_count,
  raw_count_in_range,
  archived_at,
  CASE
    WHEN raw_count_in_range = 0 THEN 'fully_compacted'
    WHEN raw_count_in_range < archived_count THEN 'partially_compacted'
    WHEN raw_count_in_range = archived_count THEN 'raw_retained'
    ELSE 'count_mismatch'
  END AS coverage_status
FROM summary_coverage
ORDER BY retention_class, range_start;

-- ----------------------------------------------------------------------------
-- 3. Gaps: compacted raw rows without a matching archive summary
-- ----------------------------------------------------------------------------
-- Identifies compacted envelopes whose created_at is not covered by any
-- archive summary for the same retention class. These are the ranges where
-- audit queries may be incomplete and a reconstruction/recovery path must be
-- exercised.
SELECT
  e.retention_class,
  DATE_TRUNC('day', e.created_at) AS gap_day,
  COUNT(*) AS uncovered_compacted_envelopes,
  MIN(e.created_at) AS first_uncovered,
  MAX(e.created_at) AS last_uncovered
FROM event_envelopes e
WHERE e.compacted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM event_archive_summaries s
    WHERE s.retention_class = e.retention_class
      AND e.created_at >= s.range_start
      AND e.created_at < s.range_end
  )
GROUP BY e.retention_class, DATE_TRUNC('day', e.created_at)
ORDER BY e.retention_class, gap_day;

-- ----------------------------------------------------------------------------
-- 4. Overall audit-completeness summary
-- ----------------------------------------------------------------------------
-- Single-row rollup for dashboards/alerts: total compacted envelopes, how many
-- are covered by an archive summary, and how many are uncovered (gaps).
WITH compacted AS (
  SELECT
    e.id,
    e.retention_class,
    e.created_at,
    EXISTS (
      SELECT 1
      FROM event_archive_summaries s
      WHERE s.retention_class = e.retention_class
        AND e.created_at >= s.range_start
        AND e.created_at < s.range_end
    ) AS covered
  FROM event_envelopes e
  WHERE e.compacted_at IS NOT NULL
)
SELECT
  COUNT(*) AS total_compacted_envelopes,
  COUNT(*) FILTER (WHERE covered) AS covered_envelopes,
  COUNT(*) FILTER (WHERE NOT covered) AS uncovered_envelopes,
  CASE
    WHEN COUNT(*) FILTER (WHERE NOT covered) = 0 THEN 'complete'
    ELSE 'incomplete'
  END AS audit_completeness
FROM compacted;