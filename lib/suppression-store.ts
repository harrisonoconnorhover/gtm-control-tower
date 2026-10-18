import { getDatabase, type DatabaseAdapter } from '@/db';
import { MAX_SUPPRESSION_RULES, normalizeSuppressionRule, suppressionRuleKey, type NormalizedSuppressionRule, type SuppressionRule } from './suppression';

type StoredRule = { rule_json: string };

async function suppressionDatabase(): Promise<DatabaseAdapter | null> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') return null;
  await db.prepare(`CREATE TABLE IF NOT EXISTS suppression_rules (
    id TEXT PRIMARY KEY NOT NULL,
    match_key TEXT UNIQUE NOT NULL,
    rule_json TEXT NOT NULL
  )`).run();
  return db;
}

/** Installation-wide lists are independent of workspace edits and CRM records. */
export async function getSuppressionRules(): Promise<SuppressionRule[]> {
  const db = await suppressionDatabase();
  return db ? readRules(db) : [];
}

export async function saveSuppressionRule(input: unknown): Promise<SuppressionRule[]> {
  return writeRules([normalizeSuppressionRule(input)]);
}

export async function importSuppressionRules(inputs: unknown): Promise<SuppressionRule[]> {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_SUPPRESSION_RULES) {
    throw new Error(`Import between 1 and ${MAX_SUPPRESSION_RULES.toLocaleString()} suppression rules.`);
  }
  // Complete validation before opening a write transaction: an invalid row imports nothing.
  return writeRules(inputs.map(normalizeSuppressionRule));
}

export async function deleteSuppressionRule(id: string): Promise<SuppressionRule[]> {
  if (!id || id.length > 120) throw new Error('Choose an existing suppression rule.');
  const db = await requireDatabase();
  await db.prepare('DELETE FROM suppression_rules WHERE id = ?').bind(id).run();
  return readRules(db);
}

async function writeRules(inputs: NormalizedSuppressionRule[]): Promise<SuppressionRule[]> {
  const db = await requireDatabase();
  const previous = await readRules(db);
  const byId = new Map(previous.map((rule) => [rule.id, rule]));
  const byKey = new Map(previous.map((rule) => [suppressionRuleKey(rule), rule]));
  const pending = new Map<string, SuppressionRule>();
  const now = new Date().toISOString();
  for (const input of inputs) {
    const key = suppressionRuleKey(input);
    const existing = input.id ? byId.get(input.id) : byKey.get(key);
    if (input.id && !existing) throw new Error('The suppression rule no longer exists. Reload the lists before editing.');
    // Reimporting a list must not erase a reviewed reason or re-enable a disabled
    // rule. Editing is explicit and carries the existing rule's ID.
    if (!input.id && existing) continue;
    const collision = byKey.get(key);
    if (collision && existing && collision.id !== existing.id) {
      throw new Error('This list already has that rule. Edit the existing rule instead.');
    }
    const rule: SuppressionRule = { ...input, id: existing?.id ?? crypto.randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now };
    if (existing) byKey.delete(suppressionRuleKey(existing));
    byKey.set(key, rule);
    byId.set(rule.id, rule);
    pending.set(rule.id, rule);
  }
  if (byId.size > MAX_SUPPRESSION_RULES) throw new Error(`Keep ${MAX_SUPPRESSION_RULES.toLocaleString()} suppression rules or fewer. Remove unused rules before importing.`);
  await db.batch([...pending.values()].map((rule) => db.prepare(`INSERT INTO suppression_rules (id, match_key, rule_json)
    VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET match_key = excluded.match_key, rule_json = excluded.rule_json`)
    .bind(rule.id, suppressionRuleKey(rule), JSON.stringify(rule))));
  return readRules(db);
}

async function requireDatabase(): Promise<DatabaseAdapter> {
  const db = await suppressionDatabase();
  if (!db) throw new Error('Suppression lists require the self-hosted SQLite app.');
  return db;
}

async function readRules(db: DatabaseAdapter): Promise<SuppressionRule[]> {
  const rows = await db.prepare('SELECT rule_json FROM suppression_rules ORDER BY match_key, id').all<StoredRule>();
  return rows.results.map((row) => JSON.parse(row.rule_json) as SuppressionRule);
}
