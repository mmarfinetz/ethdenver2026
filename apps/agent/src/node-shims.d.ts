declare module "node:fs/promises" {
  export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
}

declare module "node:path" {
  export function dirname(path: string): string;
}

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
