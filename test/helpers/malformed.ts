type Primitive = string | number | bigint | boolean | symbol | null | undefined;

type MalformedInput<T> = Partial<Record<keyof T, unknown>> | readonly unknown[] | Primitive;

// Tests use this boundary for invalid inputs and deliberately partial API mocks.
// Object fixtures retain the target's field names and allow invalid values.
export function malformed<T>(value: MalformedInput<NoInfer<T>>): T {
  return value as T;
}
