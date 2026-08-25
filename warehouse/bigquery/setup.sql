-- BigQuery setup for a synthetic GTM event warehouse. Replace YOUR_PROJECT before running.
create schema if not exists `YOUR_PROJECT.gtm_control_tower`
options(location = 'US', description = 'Synthetic portfolio data only');

create table if not exists `YOUR_PROJECT.gtm_control_tower.raw_crm_events` (
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

create table if not exists `YOUR_PROJECT.gtm_control_tower.ingestion_runs` (
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
