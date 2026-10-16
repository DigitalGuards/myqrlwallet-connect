type MalformedInput<T> =
  | Partial<Record<keyof T, unknown>>
  | readonly unknown[]
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

// This helper lets tests feed invalid data to typed functions.
// Object fixtures retain the target's field names and allow invalid values.
export function malformed<T>(value: MalformedInput<NoInfer<T>>): T {
  return value as T;
}
