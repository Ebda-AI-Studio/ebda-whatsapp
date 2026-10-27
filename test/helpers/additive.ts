/**
 * Statements in a migration that a Worker rollback cannot survive (W1-DEPLOY): anything that removes or renames a table, column, index, trigger or view,
 * changes a column in place, deletes rows, or rewrites the schema. Migrations are forward-only, so the previous Worker must still find everything it uses.
 * Returns the offending statements (comments stripped), empty when the SQL is additive.
 */
const DESTRUCTIVE: RegExp[] = [
  /\bDROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)\b/i,
  /\bRENAME\b/i,
  /\bALTER\s+TABLE\s+\S+\s+(DROP|RENAME|ALTER)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bPRAGMA\s+writable_schema\b/i,
];

export function destructiveStatements(sql: string): string[] {
  const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return stripped
    .split(';')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter((s) => s && DESTRUCTIVE.some((re) => re.test(s)))
    .map((s) => s.slice(0, 120));
}
