import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateMessyCrm } from '../fixtures/messy-crm.mjs';

const destination = resolve(process.argv[2] ?? 'outputs/incident-stress/dataset');
mkdirSync(destination, { recursive: true });
const csv = (rows) => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys({ id: row.id, objectType: row.objectType, ...row.properties })))];
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [keys.map(escape).join(','), ...rows.map((row) => { const flat = { id: row.id, objectType: row.objectType, ...row.properties }; return keys.map((key) => escape(flat[key])).join(','); })].join('\n') + '\n';
};
for (const provider of ['hubspot', 'salesforce']) {
  const data = generateMessyCrm(provider);
  const folder = resolve(destination, provider);
  mkdirSync(folder, { recursive: true });
  for (const entity of ['contacts', 'companies', 'deals', 'leads']) if (data[entity].length) writeFileSync(resolve(folder, `${entity}.csv`), csv(data[entity]));
  writeFileSync(resolve(folder, 'world.json'), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(resolve(folder, 'events.jsonl'), data.events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify({ version: data.version, seed: data.seed, fictional: true,
    counts: { contacts: data.contacts.length, companies: data.companies.length, deals: data.deals.length, leads: data.leads.length },
    expected: data.expected, scenarios: data.scenarios }, null, 2) + '\n');
  console.log(`${provider}: ${data.records.length} fictional records; ${data.events.length} event deliveries -> ${folder}`);
}
