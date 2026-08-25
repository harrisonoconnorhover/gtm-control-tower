select
  date(event_timestamp) as event_date,
  count(*) as event_count,
  countif(is_duplicate) as duplicate_events,
  countif(owner_id is null) as missing_owner_events,
  countif(lifecycle_stage not in ('lead', 'mql', 'sql', 'opportunity', 'closed_won')) as invalid_stage_events,
  safe_divide(
    countif(not is_duplicate and owner_id is not null and lifecycle_stage in ('lead', 'mql', 'sql', 'opportunity', 'closed_won')),
    count(*)
  ) as quality_rate
from {{ ref('stg_crm_events') }}
group by 1
