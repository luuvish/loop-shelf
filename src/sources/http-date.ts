/** HTTP dates, including the obsolete asctime form, always represent GMT. */
export function parseHttpDate(value: string): number {
  if (!/^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/.test(value)) return NaN;
  return Date.parse(value.endsWith("GMT") ? value : `${value} GMT`);
}
