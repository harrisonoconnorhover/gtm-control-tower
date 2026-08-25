with source as (
  select * from {{ source('crm', 'raw_crm_events') }}
),

deduplicated as (
  select
    event_id,
    lead_id,
    account_id,
    lower(trim(event_type)) as event_type,
    lower(trim(lifecycle_stage)) as lifecycle_stage,
    event_timestamp,
    lower(trim(source)) as source,
    region,
    segment,
    owner_id,
    route_seconds,
    annual_revenue,
    opportunity_amount,
    lower(trim(email_domain)) as email_domain,
    is_duplicate,
    ingested_at
  from source
  qualify row_number() over (partition by event_id order by ingested_at desc) = 1
)

select * from deduplicated
