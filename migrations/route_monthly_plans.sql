-- Monthly route plans: each route's list of facilities is kept per month, so a
-- month's changes (facilities moved to another route, new affiliations added at
-- their place in the order) never change an earlier month's list.
--
--   plan_month   the first day of the month a route link belongs to (2026-11-01)
--   keil_start_route_month(company, month)
--                copies every route's latest plan before that month into it, in
--                one step; refuses when that month or a later one already has a plan
--
-- The route lists as they are now become the November 2026 plan.
--
-- SAFE TO RUN: adds a column, two indexes and a function; existing rows only get
-- plan_month = 2026-11-01. Nothing is deleted. Can be run twice.
-- Run in the Supabase SQL Editor of the KEIL project, then deploy the Keil
-- backend straight away: the old backend does not send plan_month, so adding a
-- facility to a route fails (with an error, nothing saved) until it is deployed.
--
-- Undo (only before any month after November 2026 is started):
--   DROP FUNCTION IF EXISTS keil_start_route_month(uuid, date);
--   ALTER TABLE keil_route_assignments DROP COLUMN plan_month;

ALTER TABLE keil_route_assignments ADD COLUMN IF NOT EXISTS plan_month date;
UPDATE keil_route_assignments SET plan_month = DATE '2026-11-01' WHERE plan_month IS NULL;
ALTER TABLE keil_route_assignments ALTER COLUMN plan_month SET NOT NULL;
ALTER TABLE keil_route_assignments DROP CONSTRAINT IF EXISTS keil_route_assignments_plan_month_first_day;
ALTER TABLE keil_route_assignments ADD CONSTRAINT keil_route_assignments_plan_month_first_day
  CHECK (plan_month = date_trunc('month', plan_month)::date);

CREATE INDEX IF NOT EXISTS idx_keil_route_assignments_route_month ON keil_route_assignments (route_id, plan_month);
CREATE INDEX IF NOT EXISTS idx_keil_route_assignments_company_month ON keil_route_assignments (company_id, plan_month);

CREATE OR REPLACE FUNCTION keil_start_route_month(p_company uuid, p_month date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_copied integer;
BEGIN
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Month must be the first day of a month';
  END IF;
  -- One start at a time per company, so two clicks cannot copy twice
  PERFORM pg_advisory_xact_lock(hashtext('keil_start_route_month:' || p_company::text));
  IF EXISTS (SELECT 1 FROM keil_route_assignments WHERE company_id = p_company AND plan_month >= p_month) THEN
    RAISE EXCEPTION 'The % plan (or a later one) has already been started', to_char(p_month, 'FMMonth YYYY');
  END IF;

  INSERT INTO keil_route_assignments
    (route_id, hce_id, collection_type, collection_days, remarks, sequence_order, company_id, sl_no, plan_month)
  SELECT a.route_id, a.hce_id, a.collection_type, a.collection_days, a.remarks, a.sequence_order, a.company_id, a.sl_no, p_month
  FROM keil_route_assignments a
  WHERE a.company_id = p_company
    AND a.plan_month = (SELECT max(b.plan_month) FROM keil_route_assignments b
                        WHERE b.company_id = p_company AND b.plan_month < p_month);
  GET DIAGNOSTICS v_copied = ROW_COUNT;
  RETURN v_copied;
END $$;

-- Let PostgREST see the new column and function right away.
NOTIFY pgrst, 'reload schema';

-- CHECK (only reads): every row has a month; all of them November 2026.
SELECT plan_month, count(*) AS links FROM keil_route_assignments GROUP BY plan_month ORDER BY plan_month;
