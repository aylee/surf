import { errorMessage } from "../adapters/types";
import type { PendingStatement, PersistenceResult } from "./types";

export async function runPendingStatements(
  db: D1Database,
  pending: PendingStatement[]
): Promise<PersistenceResult> {
  if (pending.length === 0) return { rowsWritten: 0, errors: [] };

  if (typeof db.batch === "function") {
    const chunkSize = 50;
    let rowsWritten = 0;
    const errors: string[] = [];
    for (let start = 0; start < pending.length; start += chunkSize) {
      const chunk = pending.slice(start, start + chunkSize);
      try {
        await db.batch(chunk.map((item) => item.statement));
        rowsWritten += chunk.length;
      } catch (error) {
        errors.push(`${chunk[0]?.label ?? "D1"} batch starting at ${start}: ${errorMessage(error)}`);
      }
    }
    return { rowsWritten, errors };
  }

  let rowsWritten = 0;
  const errors: string[] = [];
  for (const item of pending) {
    try {
      await item.statement.run();
      rowsWritten += 1;
    } catch (error) {
      errors.push(`${item.label}: ${errorMessage(error)}`);
    }
  }
  return { rowsWritten, errors };
}
