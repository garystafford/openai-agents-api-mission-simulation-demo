import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// Single-process store. Atomic replacement and fsync precede acknowledging a mutation.
// The directory contains private mission conversations and must not be served by HTTP.
export class DurableJson<T> {
  readonly directory?: string;
  private readonly memory = new Map<string, T>();
  constructor(directory?: string) {
    this.directory = directory ? resolve(directory) : undefined;
    if (this.directory) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key.");
    return join(this.directory!, key + ".json");
  }
  keys(): string[] {
    return this.directory
      ? readdirSync(this.directory)
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .map((name) => name.slice(0, -5))
      : [...this.memory.keys()];
  }
  get(key: string): T | undefined {
    if (!this.directory) return structuredClone(this.memory.get(key));
    try {
      return JSON.parse(readFileSync(this.path(key), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Mission storage could not be read; existing data was preserved.", {
        cause: error,
      });
    }
  }
  set(key: string, value: T) {
    if (!this.directory) {
      this.memory.set(key, structuredClone(value));
      return;
    }
    const path = this.path(key);
    const temporary = path + "." + randomUUID() + ".tmp";
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const dir = openSync(this.directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  delete(key: string) {
    if (!this.directory) {
      this.memory.delete(key);
      return;
    }
    try {
      unlinkSync(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
