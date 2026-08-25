select
  date(event_timestamp) as event_date,
  region,
  segment,
  count(*) as routed_leads,
  approx_quantiles(route_seconds, 100)[offset(50)] as median_route_seconds,
  countif(route_seconds <= 120) / count(*) as sla_attainment_rate,
  countif(route_seconds > 120) as breached_leads
from {{ ref('stg_crm_events') }}
where event_type = 'lifecycle_changed'
group by 1, 2, 3
