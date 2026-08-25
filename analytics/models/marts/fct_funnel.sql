select
  date_trunc(event_timestamp, month) as month,
  segment,
  region,
  count(distinct lead_id) as leads,
  count(distinct if(lifecycle_stage in ('mql', 'sql', 'opportunity', 'closed_won'), lead_id, null)) as mqls,
  count(distinct if(lifecycle_stage in ('sql', 'opportunity', 'closed_won'), lead_id, null)) as sqls,
  count(distinct if(lifecycle_stage in ('opportunity', 'closed_won'), lead_id, null)) as opportunities,
  count(distinct if(lifecycle_stage = 'closed_won', lead_id, null)) as closed_won,
  sum(if(lifecycle_stage = 'closed_won', opportunity_amount, 0)) as booked_revenue
from {{ ref('stg_crm_events') }}
group by 1, 2, 3
