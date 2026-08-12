# CCB Tools -- Postgres Migration (Staging)

This is a fully isolated copy-and-test environment. It does NOT touch the live
app or Monday.com. Nothing here goes live until we deliberately merge it.

## What's here
- `schema.sql` -- the full database structure, one-to-one with every Monday board
- `migrate-from-monday.js` -- pulls everything from Monday (read-only) into Postgres.
  Safe to re-run any time; it upserts, never duplicates.
- `server.js` -- minimal staging server: health check + endpoints to verify the
  migrated data (row counts, sample rows). This is NOT the full app yet -- that's
  the next phase (rewriting every endpoint to use Postgres instead of Monday).
- `render.yaml` -- one-click Blueprint that provisions a new Postgres database
  and a new staging web service, fully separate from production.

## To stand this up on Render
1. Render Dashboard -> New -> Blueprint
2. Connect this repo, select branch `postgres-migration`
3. Click Apply -- this creates the database and the staging service automatically
4. In the new `ccb-tools-staging` service's Environment tab, add `MONDAY_API_KEY`
   (same value as the live service) -- only needed to run the migration once
5. Open a shell on the service (or run locally against the DATABASE_URL Render
   gives you) and run: `node migrate-from-monday.js`
6. Visit `https://ccb-tools-staging.onrender.com/api/admin/row-counts` to confirm
   everything came across

## Tested already
Both the schema and the full migration script have been run end-to-end against
a real Postgres instance and the actual live Monday data, with zero errors.
Spot-checked orders, products, and tasks -- all values came through correctly.
