import { z } from 'zod';
import type { ClassFieldNames } from '../ast/types.js';

const NO_FIELDS: ClassFieldNames = { instance: [], static: [] };
const classFieldNamesSchema = z.object({ instance: z.array(z.string()), static: z.array(z.string()) });

/**
 * The stored `symbols.fields` of a class row (D115). A row with none has no
 * fields, and so has one whose value this version cannot read.
 */
export function fieldNamesOf(stored: string | null): ClassFieldNames {
  if (stored === null) return NO_FIELDS;
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return NO_FIELDS;
  }
  const parsed = classFieldNamesSchema.safeParse(value);
  return parsed.success ? parsed.data : NO_FIELDS;
}
