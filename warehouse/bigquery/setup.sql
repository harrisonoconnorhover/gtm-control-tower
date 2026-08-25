-- Portable template. Run npm run setup -- --project YOUR_PROJECT to render it.
create schema if not exists `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__`
options(location = 'US', description = 'Synthetic portfolio data only');

create table if not exists `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.raw_crm_events` (
  event_id string not null,
  lead_id string not null,
  account_id string not null,
  event_type string not null,
  lifecycle_stage string not null,
  event_timestamp timestamp not null,
  source string,
  region string,
  segment string,
  owner_id string,
  route_seconds int64,
  annual_revenue int64,
  opportunity_amount int64,
  email_domain string,
  is_duplicate bool,
  ingested_at timestamp default current_timestamp()
)
partition by date(event_timestamp)
cluster by lifecycle_stage, segment, region;

create table if not exists `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.ingestion_runs` (
  run_id string not null,
  workflow_name string not null,
  started_at timestamp not null,
  finished_at timestamp,
  source_count int64,
  loaded_count int64,
  rejected_count int64,
  status string
)
partition by date(started_at);
