-- Parameterized n8n worker. Required STRING parameters:
-- @scenario, @action, @request_id

declare affected int64 default 0;
declare approved_at timestamp default current_timestamp();
declare event_id string default concat('REPAIR-', @scenario, '-', @request_id);

if @scenario = 'duplicate-surge' then
  update `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state` as target
  set
    canonical_contact_id = duplicates.canonical_contact_id,
    record_status = 'merged',
    last_action = 'merged_into_canonical',
    updated_at = approved_at
  from (
    select
      contact_id,
      first_value(contact_id) over (
        partition by normalized_email
        order by if(raw_email = lower(trim(raw_email)), 0, 1), contact_id
      ) as canonical_contact_id
    from `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state`
    where seed_batch = 'funky-v1'
      and normalized_email is not null
      and 'duplicate_identity' in unnest(quality_flags)
  ) as duplicates
  where target.seed_batch = 'funky-v1'
    and target.contact_id = duplicates.contact_id
    and target.contact_id != duplicates.canonical_contact_id
    and target.record_status = 'active';
  set affected = @@row_count;

  update `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state`
  set
    quality_flags = array(
      select flag from unnest(quality_flags) as flag where flag != 'duplicate_identity'
    ),
    last_action = 'canonical_record_retained',
    updated_at = approved_at
  where seed_batch = 'funky-v1'
    and record_status = 'active'
    and 'duplicate_identity' in unnest(quality_flags);

elseif @scenario = 'routing-overload' then
  update `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state`
  set
    owner_id = 'CE-ENT-OVERFLOW',
    last_action = 'rerouted_from_ne_enterprise',
    updated_at = approved_at
  where seed_batch = 'funky-v1'
    and record_status = 'active'
    and region = 'Northeast'
    and segment = 'Enterprise'
    and owner_id = 'NE-ENT';
  set affected = @@row_count;

elseif @scenario = 'stage-regression' then
  update `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state`
  set
    lifecycle_stage = expected_lifecycle_stage,
    quality_flags = array(
      select flag from unnest(quality_flags) as flag where flag != 'stage_regression'
    ),
    last_action = 'lifecycle_replayed',
    updated_at = approved_at
  where seed_batch = 'funky-v1'
    and record_status = 'active'
    and 'stage_regression' in unnest(quality_flags);
  set affected = @@row_count;

else
  raise using message = 'Unsupported repair scenario';
end if;

insert into `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.repair_runs` (
  run_id, seed_batch, scenario, action, status, affected_records, started_at, finished_at
)
values (@request_id, 'funky-v1', @scenario, @action, 'executed', affected, approved_at, current_timestamp());

insert into `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.raw_crm_events` (
  event_id, lead_id, account_id, event_type, lifecycle_stage, event_timestamp,
  source, region, segment, owner_id, route_seconds, annual_revenue,
  opportunity_amount, email_domain, is_duplicate
)
values (
  event_id, 'CONTROL-TOWER', 'SYSTEM', concat('repair_executed_', @scenario),
  'lead', approved_at, 'control_tower', @scenario, 'System', 'CONTROL-TOWER',
  0, 0, 0, null, false
);

select
  true as accepted,
  'executed' as status,
  @scenario as scenario,
  @action as action,
  @request_id as request_id,
  event_id,
  affected as affected_records,
  approved_at;
