import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const execFileAsync = promisify(execFile);

export interface Identity {
  nodeId: string;
  owner: string;
}

/** Load the local agent identity from ~/.bridges/identity/keypair.json */
export async function loadIdentity(): Promise<Identity> {
  const idPath = join(homedir(), '.bridges', 'identity', 'keypair.json');
  const raw = await readFile(idPath, 'utf-8');
  return JSON.parse(raw) as Identity;
}

/** Call the bridges CLI binary and return stdout */
export async function bridgesCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('bridges', args);
  return stdout.trim();
}

/** Read a shared file from .shared/, return empty string if missing */
export async function readSharedFile(filename: string, projectDir?: string): Promise<string> {
  const dir = projectDir ?? process.cwd();
  const filePath = join(dir, '.shared', filename);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** Tool definition shape that agent runtimes expect */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}
