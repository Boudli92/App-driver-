/** Gabarits HTML avec échappement automatique (anti-XSS). */
export class Raw {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}
export const raw = (s: string): Raw => new Raw(s);

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type Part = Raw | string | number | null | undefined | false | Part[];

function render(v: Part): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Raw) return v.value;
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = "";
  strings.forEach((s, i) => { out += s + (i < values.length ? render(values[i] as Part) : ""); });
  return new Raw(out);
}
