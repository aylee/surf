export type SafeLogFields = Record<string, boolean | number | string | null>;

export interface RunnerLogger {
  event(name: string, fields?: SafeLogFields): void;
}

export class JsonLineLogger implements RunnerLogger {
  constructor(private readonly write: (line: string) => void = (line) => console.info(line)) {}

  event(name: string, fields: SafeLogFields = {}): void {
    this.write(JSON.stringify({ event: name, ...fields }));
  }
}

export class MemoryLogger implements RunnerLogger {
  readonly entries: Array<{ event: string } & SafeLogFields> = [];

  event(name: string, fields: SafeLogFields = {}): void {
    this.entries.push({ event: name, ...fields });
  }
}
