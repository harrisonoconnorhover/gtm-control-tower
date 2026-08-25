with events as (
  select *
  from `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.raw_crm_events`
  where event_timestamp >= timestamp_sub(current_timestamp(), interval 30 day)
)
select
  current_timestamp() as generated_at,
  count(*) as total_events,
  countif(event_type = 'lead_routed') as routed_leads,
  countif(is_duplicate) as duplicate_events,
  countif(owner_id is null) as missing_owner_events,
  coalesce(approx_quantiles(if(event_type in ('lead_routed', 'lifecycle_changed'), route_seconds, null), 100 ignore nulls)[safe_offset(50)], 0) as median_route_seconds,
  round(100 * safe_divide(countif(not is_duplicate and owner_id is not null and lifecycle_stage in ('lead', 'mql', 'sql', 'opportunity', 'closed_won')), greatest(count(*), 1)), 1) as quality_rate,
  max(event_timestamp) as latest_event_at,
  count(distinct lead_id) as leads,
  count(distinct if(lifecycle_stage in ('mql', 'sql', 'opportunity', 'closed_won'), lead_id, null)) as mqls,
  count(distinct if(lifecycle_stage in ('sql', 'opportunity', 'closed_won'), lead_id, null)) as sqls,
  count(distinct if(lifecycle_stage in ('opportunity', 'closed_won'), lead_id, null)) as opportunities,
  count(distinct if(lifecycle_stage = 'closed_won', lead_id, null)) as closed_won,
  max(if(starts_with(event_type, 'repair_'), event_timestamp, null)) as latest_repair_at,
  array_agg(if(starts_with(event_type, 'repair_'), regexp_replace(event_type, r'^repair_(approved|executed)_', ''), null) ignore nulls order by event_timestamp desc limit 1)[safe_offset(0)] as latest_repair_scenario,
  coalesce((
    select to_json_string(array_agg(struct(
      contact_id, full_name, raw_email, normalized_email, company, region, segment,
      lifecycle_stage, expected_lifecycle_stage, owner_id, canonical_contact_id,
      record_status, last_action, quality_flags, updated_at
    ) order by contact_id))
    from `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.crm_contact_state`
    where seed_batch = 'funky-v1'
  ), '[]') as contacts_json,
  coalesce((
    select to_json_string(array_agg(struct(
      run_id, scenario, action, status, affected_records, finished_at
    ) order by finished_at desc limit 6))
    from `__GCP_PROJECT_ID__.__BIGQUERY_SOURCE_DATASET__.repair_runs`
    where seed_batch = 'funky-v1'
  ), '[]') as repair_history_json
from events;
