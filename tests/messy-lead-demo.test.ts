import { describe, expect, it } from 'vitest';
import { importContactsCsv } from '../lib/csv-control-tower';
import { messyLeadDemoCsv, previewMessyLeadDemo, runMessyLeadDemo } from '../lib/messy-lead-demo';

describe('64-row messy lead demonstration', () => {
  it('ships a deterministic, importable batch with multiple failure families', () => {
    const contacts = importContactsCsv(messyLeadDemoCsv()).contacts;
    const preview = previewMessyLeadDemo();

    expect(contacts).toHaveLength(64);
    expect(preview.duplicateRows).toBeGreaterThanOrEqual(7);
    expect(preview.routingExceptions).toBeGreaterThanOrEqual(5);
    expect(preview.lifecycleRegressions).toBeGreaterThanOrEqual(7);
    expect(preview.initiallyFlagged).toBeGreaterThanOrEqual(20);
  });

  it('executes merge, reroute, and replay while holding unresolved rows', () => {
    const result = runMessyLeadDemo();

    expect(result.mergedRows).toBe(result.duplicateRows);
    expect(result.reroutedRows).toBeGreaterThan(0);
    expect(result.replayedRows).toBe(result.lifecycleRegressions);
    expect(result.activeRows).toBe(64 - result.mergedRows);
    expect(result.readyRows + result.heldRows).toBe(result.activeRows);
    expect(result.afterQuality).toBeGreaterThan(result.beforeQuality);
  });
});
