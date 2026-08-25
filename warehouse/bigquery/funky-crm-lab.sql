-- Deliberately messy, synthetic CRM state used by the live repair demo.
-- Safe to rerun: only the named synthetic batch is replaced.

create table if not exists `harrison-gtm-control-tower.gtm_control_tower.crm_contact_state` (
  seed_batch string not null,
  contact_id string not null,
  full_name string,
  raw_email string,
  normalized_email string,
  company string,
  normalized_company string,
  region string,
  segment string,
  annual_revenue int64,
  lifecycle_stage string,
  expected_lifecycle_stage string,
  owner_id string,
  canonical_contact_id string,
  record_status string,
  last_action string,
  quality_flags array<string>,
  updated_at timestamp
)
cluster by seed_batch, record_status, region, segment;

create table if not exists `harrison-gtm-control-tower.gtm_control_tower.repair_runs` (
  run_id string not null,
  seed_batch string not null,
  scenario string not null,
  action string not null,
  status string not null,
  affected_records int64,
  started_at timestamp,
  finished_at timestamp
)
partition by date(started_at)
cluster by seed_batch, scenario, status;

delete from `harrison-gtm-control-tower.gtm_control_tower.crm_contact_state`
where seed_batch = 'funky-v1';

delete from `harrison-gtm-control-tower.gtm_control_tower.repair_runs`
where seed_batch = 'funky-v1';

insert into `harrison-gtm-control-tower.gtm_control_tower.crm_contact_state` (
  seed_batch, contact_id, full_name, raw_email, normalized_email, company,
  normalized_company, region, segment, annual_revenue, lifecycle_stage,
  expected_lifecycle_stage, owner_id, canonical_contact_id, record_status,
  last_action, quality_flags, updated_at
)
values
  ('funky-v1', 'F-001', 'Alex Morgan', 'alex@northstar.ai', 'alex@northstar.ai', 'North Star Robotics', 'northstar robotics', 'Northeast', 'Enterprise', 42000000, 'customer', 'customer', 'NE-ENT', null, 'active', 'seeded', ['duplicate_identity'], current_timestamp()),
  ('funky-v1', 'F-002', ' Alex  Morgan ', ' ALEX@NORTHSTAR.AI ', 'alex@northstar.ai', 'NORTHSTAR ROBOTICS, INC.', 'northstar robotics', 'Northeast', 'Enterprise', 42000000, 'mql', 'customer', 'NE-ENT', null, 'active', 'seeded', ['duplicate_identity', 'stage_regression'], current_timestamp()),
  ('funky-v1', 'F-003', 'Jamie Ortega', 'jamie.ortega@northstar.ai', 'jamie.ortega@northstar.ai', 'Northstar Robotics LLC', 'northstar robotics', 'Northeast', 'Enterprise', 42000000, 'sql', 'sql', 'NE-ENT', null, 'active', 'seeded', [], current_timestamp()),
  ('funky-v1', 'F-004', 'Priya Shah', 'priya@arc-labs.com', 'priya@arc-labs.com', 'Arc Labs', 'arc labs', 'Northeast', 'Enterprise', 28000000, 'mql', 'mql', 'NE-ENT', null, 'active', 'seeded', ['duplicate_identity'], current_timestamp()),
  ('funky-v1', 'F-005', 'Priya S.', 'Priya+EVENT@ARC-LABS.COM', 'priya@arc-labs.com', 'ARC LABS, LTD', 'arc labs', 'Northeast', 'Enterprise', 28000000, 'lead', 'mql', 'NE-ENT', null, 'active', 'seeded', ['duplicate_identity'], current_timestamp()),
  ('funky-v1', 'F-006', 'Mia Santos', 'mia.santos @ gmail.com', null, null, null, 'West', 'SMB', 0, 'lead', 'lead', null, null, 'active', 'seeded', ['invalid_email', 'missing_company', 'missing_owner'], current_timestamp()),
  ('funky-v1', 'F-007', 'Lukas Müller', 'lukas@überdata.example', 'lukas@uberdata.example', 'ÜberData GmbH', 'uberdata', 'Central', 'Mid-Market', 9000000, 'sql', 'sql', 'CE-MM', null, 'active', 'seeded', ['unicode_domain_normalized'], current_timestamp()),
  ('funky-v1', 'F-008', 'Sam Lee', 'sales@acme.test', 'sales@acme.test', 'Acme Corp.', 'acme', 'Northeast', 'Enterprise', 65000000, 'opportunity', 'opportunity', 'NE-ENT', null, 'active', 'seeded', [], current_timestamp()),
  ('funky-v1', 'F-009', 'Sam Lee', 'sam.lee@acme.test', 'sam.lee@acme.test', 'ACME', 'acme', 'Northeast', 'Enterprise', 65000000, 'sql', 'sql', 'NE-ENT', null, 'active', 'seeded', [], current_timestamp()),
  ('funky-v1', 'F-010', 'Robin Cho', 'robin@oakandpine.co', 'robin@oakandpine.co', 'Oak & Pine', 'oak and pine', 'Northeast', 'Mid-Market', 12000000, 'mql', 'sql', 'NE-MM', null, 'active', 'seeded', ['stage_regression'], current_timestamp());

select
  'funky-v1' as seed_batch,
  count(*) as contact_count,
  countif(array_length(quality_flags) > 0) as dirty_records
from `harrison-gtm-control-tower.gtm_control_tower.crm_contact_state`
where seed_batch = 'funky-v1';
