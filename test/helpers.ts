export function at<T>(items: ArrayLike<T>, index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`Expected a test item at index ${index}`);
  return value;
}
