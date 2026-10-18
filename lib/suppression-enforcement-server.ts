import { matchSuppressionRules } from './suppression';
import { getSuppressionRules } from './suppression-store';
import type { PortableCrmContact } from './crm-workflow';

/** Read current rules at the write boundary, never client-supplied match metadata. */
export async function assertNoSuppressedContacts(contacts: PortableCrmContact[]): Promise<void> {
  const rules = await getSuppressionRules();
  const suppressed = contacts.flatMap((contact) => {
    const matches = matchSuppressionRules({ rawEmail: contact.email, company: contact.company, website: contact.website }, rules);
    return matches.length ? [`${contact.contactId}: ${matches.map((match) => `${match.listName}: ${match.reason}`).join('; ')}`] : [];
  });
  if (suppressed.length) throw new Error(`Suppressed rows cannot be imported. ${suppressed.join(' | ')}`);
}
