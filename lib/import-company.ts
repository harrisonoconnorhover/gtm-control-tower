import type { LiveContactState } from './live-control-tower';

/** Use the explicitly mapped Company object; never fill its gaps from Contact context. */
export function importCompanyFields(row: LiveContactState): { company: string; website: string } {
  return row.importObject === 'contact_company'
    ? { company: row.associatedCompany?.name ?? '', website: row.associatedCompany?.website ?? '' }
    : { company: row.company ?? '', website: row.website ?? '' };
}
