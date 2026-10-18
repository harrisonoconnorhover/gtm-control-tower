import { getDatabase, type DatabaseAdapter } from '@/db';
import { validateImportTemplate, type ImportTemplate } from './import-template';

async function templateDatabase(): Promise<DatabaseAdapter> {
  const db = await getDatabase();
  if (db.kind !== 'sqlite') throw new Error('Shared import templates require the self-hosted SQLite app.');
  await db.prepare('CREATE TABLE IF NOT EXISTS import_templates (id TEXT PRIMARY KEY NOT NULL, template_json TEXT NOT NULL)').run();
  return db;
}

export async function getImportTemplates(): Promise<ImportTemplate[]> {
  const db = await templateDatabase();
  const result = await db.prepare('SELECT template_json FROM import_templates ORDER BY id').all<{ template_json: string }>();
  return result.results.map((row) => JSON.parse(row.template_json) as ImportTemplate).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveImportTemplate(value: unknown): Promise<ImportTemplate[]> {
  const input = validateImportTemplate(value);
  const requestedId = (value as { id?: unknown }).id;
  const templates = await getImportTemplates();
  const existing = requestedId === undefined ? undefined : templates.find((template) => template.id === requestedId);
  if (requestedId !== undefined && !existing) throw new Error('The template no longer exists. Reload before updating it.');
  if (!existing && templates.length >= 100) throw new Error('Keep at most 100 shared templates. Remove an unused template first.');
  if (templates.some((template) => template.id !== existing?.id && template.importObject === input.importObject && template.name.toLowerCase() === input.name.toLowerCase())) throw new Error('A template with that name already exists for this object. Update it or use a different name.');
  const now = new Date().toISOString();
  const template: ImportTemplate = { ...input, id: existing?.id ?? crypto.randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now };
  const db = await templateDatabase();
  await db.prepare('INSERT INTO import_templates (id, template_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET template_json = excluded.template_json')
    .bind(template.id, JSON.stringify(template)).run();
  return getImportTemplates();
}

export async function deleteImportTemplate(id: string): Promise<ImportTemplate[]> {
  if (!id || id.length > 120) throw new Error('Choose an existing import template.');
  const db = await templateDatabase();
  await db.prepare('DELETE FROM import_templates WHERE id = ?').bind(id).run();
  return getImportTemplates();
}
