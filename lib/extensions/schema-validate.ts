import type { SimpleField } from "./manifest";

/**
 * Deterministic validator for the constrained SimpleField schema declared in
 * extension manifests. Pure and recursive with a hard depth cap so a hostile
 * manifest cannot blow the stack.
 */
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS_VALIDATED = 200;

export function validateSimpleField(
  value: unknown,
  field: SimpleField,
  path = "value",
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH) return [`${path}: schema nesting too deep.`];

  if (value === null || value === undefined) {
    return field.required ? [`${path}: required value is missing.`] : [];
  }

  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return [`${path}: expected a string.`];
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return [`${path}: string exceeds ${field.maxLength} characters.`];
      }
      if (field.enum && !field.enum.includes(value)) {
        return [`${path}: value must be one of ${field.enum.map((item) => JSON.stringify(item)).join(", ")}.`];
      }
      return [];
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path}: expected a finite number.`];
      if (field.min !== undefined && value < field.min) return [`${path}: must be >= ${field.min}.`];
      if (field.max !== undefined && value > field.max) return [`${path}: must be <= ${field.max}.`];
      if (field.enum && !field.enum.includes(value)) {
        return [`${path}: value must be one of ${field.enum.join(", ")}.`];
      }
      return [];
    }
    case "boolean": {
      if (typeof value !== "boolean") return [`${path}: expected a boolean.`];
      return [];
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: expected an array.`];
      if (field.max !== undefined && value.length > field.max) {
        return [`${path}: array exceeds ${field.max} items.`];
      }
      if (!field.items) return [];
      const errors: string[] = [];
      for (const [index, item] of value.slice(0, MAX_ARRAY_ITEMS_VALIDATED).entries()) {
        errors.push(...validateSimpleField(item, field.items, `${path}[${index}]`, depth + 1));
      }
      return errors;
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return [`${path}: expected an object.`];
      const record = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const [key, child] of Object.entries(field.properties ?? {})) {
        errors.push(...validateSimpleField(record[key], child, `${path}.${key}`, depth + 1));
      }
      if (field.min !== undefined && Object.keys(record).length < field.min) {
        return [`${path}: object must contain at least ${field.min} keys.`];
      }
      if (field.max !== undefined && Object.keys(record).length > field.max) {
        return [`${path}: object must contain at most ${field.max} keys.`];
      }
      return errors;
    }
    default:
      return [`${path}: unsupported field type.`];
  }
}

/** Validates an object against a `{field: SimpleField}` map (required fields included). */
export function validateSimpleRecord(
  value: unknown,
  fields: Record<string, SimpleField> | undefined,
  path = "input",
): string[] {
  if (!fields || Object.keys(fields).length === 0) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`${path}: expected an object.`];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (field.required && (record[key] === undefined || record[key] === null)) {
      errors.push(`${path}.${key}: required field is missing.`);
      continue;
    }
    errors.push(...validateSimpleField(record[key], field, `${path}.${key}`));
  }
  return errors;
}
