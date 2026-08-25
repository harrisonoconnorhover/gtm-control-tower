#!/usr/bin/env python3
"""Generate deterministic synthetic CRM events for the GTM Control Tower demo."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

STAGES = ("lead", "mql", "sql", "opportunity", "closed_won")
STAGE_WEIGHTS = (1318, 1281, 1217, 572, 612)
REGIONS = ("Northeast", "Southeast", "Central", "West")
SEGMENTS = ("SMB", "Mid-Market", "Enterprise")
SOURCES = ("organic", "paid_search", "partner", "outbound", "event")


@dataclass(frozen=True)
class CrmEvent:
    event_id: str
    lead_id: str
    account_id: str
    event_type: str
    lifecycle_stage: str
    event_timestamp: str
    source: str
    region: str
    segment: str
    owner_id: str
    route_seconds: int
    annual_revenue: int
    opportunity_amount: int | None
    email_domain: str
    is_duplicate: bool


def stable_id(prefix: str, value: str) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def stage_assignments(count: int, rng: random.Random) -> list[str]:
    """Preserve the dashboard's cumulative funnel ratios for any sample size."""
    raw_counts = [count * weight / sum(STAGE_WEIGHTS) for weight in STAGE_WEIGHTS]
    counts = [int(value) for value in raw_counts]
    remainder = count - sum(counts)
    priority = sorted(
        range(len(STAGES)),
        key=lambda index: raw_counts[index] - counts[index],
        reverse=True,
    )
    for index in priority[:remainder]:
        counts[index] += 1
    assignments = [stage for stage, amount in zip(STAGES, counts) for _ in range(amount)]
    rng.shuffle(assignments)
    return assignments


def make_event(index: int, stage: str, rng: random.Random, start: datetime) -> CrmEvent:
    lead_id = f"LEAD-{index + 1:05d}"
    segment = rng.choices(SEGMENTS, weights=(0.50, 0.34, 0.16), k=1)[0]
    region = rng.choice(REGIONS)
    event_timestamp = start + timedelta(minutes=rng.randint(0, 43_200))
    route_seconds = max(8, int(rng.lognormvariate(4.25, 0.55)))
    annual_revenue = rng.randint(1, 400) * 100_000
    opportunity_amount = None
    if stage in {"opportunity", "closed_won"}:
        opportunity_amount = rng.randint(15, 240) * 1_000
    root = max(1, index - 1) if index % 173 == 0 else index
    domain = f"account-{root:05d}.example"
    return CrmEvent(
        event_id=stable_id("EVT", f"{lead_id}:{stage}:{event_timestamp.isoformat()}"),
        lead_id=lead_id,
        account_id=stable_id("ACC", domain),
        event_type="lifecycle_changed",
        lifecycle_stage=stage,
        event_timestamp=event_timestamp.isoformat().replace("+00:00", "Z"),
        source=rng.choice(SOURCES),
        region=region,
        segment=segment,
        owner_id=f"USR-{region[:2].upper()}-{rng.randint(1, 12):02d}",
        route_seconds=route_seconds,
        annual_revenue=annual_revenue,
        opportunity_amount=opportunity_amount,
        email_domain=domain,
        is_duplicate=index % 173 == 0,
    )


def write_events(events: list[CrmEvent], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.suffix == ".csv":
        with destination.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=asdict(events[0]).keys())
            writer.writeheader()
            writer.writerows(asdict(event) for event in events)
        return
    with destination.open("w", encoding="utf-8") as handle:
        for event in events:
            handle.write(json.dumps(asdict(event), separators=(",", ":")) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=5_000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=Path("data/crm_events.jsonl"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.count < 1:
        raise SystemExit("--count must be at least 1")
    rng = random.Random(args.seed)
    start = datetime(2026, 7, 1, tzinfo=UTC)
    stages = stage_assignments(args.count, rng)
    events = [make_event(index, stage, rng, start) for index, stage in enumerate(stages)]
    write_events(events, args.output)
    print(f"Wrote {len(events):,} synthetic events to {args.output}")


if __name__ == "__main__":
    main()
