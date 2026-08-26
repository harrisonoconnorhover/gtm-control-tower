import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  countCsvRepairCandidates,
  executeCsvRepair,
  exportContactsCsv,
  importContactsCsv,
  isDestinationReadyContact,
  previewContactsCsv,
} from '../lib/csv-control-tower';

const fixture = readFileSync(new URL('../public/sec-public-company-messy-crm.csv', import.meta.url), 'utf8');
const snapshot = JSON.parse(readFileSync(new URL('../fixtures/sec-company-snapshot.json', import.meta.url), 'utf8')) as {
  source: string;
  data: [number, string, string, string][];
};

describe('SEC public-company messy CRM fixture', () => {
  it('is traceable public company data with synthetic contact identities', () => {
    expect(snapshot.source).toBe('https://www.sec.gov/files/company_tickers_exchange.json');
    expect(snapshot.data).toHaveLength(24);
    const preview = previewContactsCsv(fixture);
    expect(preview.sourceRows).toBe(72);
    expect(preview.suggestedMapping).toMatchObject({
      contactId: 'record_id',
      fullName: 'contact_name',
      rawEmail: 'email_address',
      company: 'account_name',
      ownerId: 'sales_owner',
    });
    const imported = importContactsCsv(fixture).contacts;
    expect(imported).toHaveLength(72);
    expect(imported.every((contact) => contact.rawEmail.toLowerCase().includes('example.com')
      || contact.rawEmail.toLowerCase().includes('überdata.example'))).toBe(true);
    expect(imported.every((contact) => !contact.website || contact.website.endsWith('.example'))).toBe(true);
  });

  it('contains realistic defects and repairs every executable class', () => {
    const imported = importContactsCsv(fixture).contacts;
    for (const flag of [
      'duplicate_identity', 'invalid_email', 'missing_company', 'missing_owner',
      'stage_regression', 'plus_address_present', 'unicode_domain_present',
    ]) {
      expect(imported.some((contact) => contact.qualityFlags.includes(flag)), flag).toBe(true);
    }

    const readyBefore = imported.filter(isDestinationReadyContact).length;
    expect(countCsvRepairCandidates(imported, 'duplicate-surge')).toBeGreaterThan(0);
    const merged = executeCsvRepair(imported, 'duplicate-surge').contacts;
    expect(countCsvRepairCandidates(merged, 'duplicate-surge')).toBe(0);
    expect(countCsvRepairCandidates(merged, 'routing-overload')).toBeGreaterThan(0);
    const rerouted = executeCsvRepair(merged, 'routing-overload').contacts;
    expect(countCsvRepairCandidates(rerouted, 'routing-overload')).toBe(0);
    expect(countCsvRepairCandidates(rerouted, 'stage-regression')).toBeGreaterThan(0);
    const replayed = executeCsvRepair(rerouted, 'stage-regression').contacts;
    expect(countCsvRepairCandidates(replayed, 'stage-regression')).toBe(0);
    expect(replayed.filter(isDestinationReadyContact).length).toBeGreaterThan(readyBefore);
    expect(importContactsCsv(exportContactsCsv(replayed)).contacts).toHaveLength(72);
  });
});
