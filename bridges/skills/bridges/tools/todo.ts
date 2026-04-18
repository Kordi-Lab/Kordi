import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readSharedFile } from './shared.js';
import type { ToolDefinition } from './shared.js';

export const todoAdd: ToolDefinition = {
  name: 'todo_add',
  description: 'Add a task to .shared/TODOS.md with an assignee.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description' },
      assignee: { type: 'string', description: 'Node ID or owner name of the assignee' },
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
    required: ['task', 'assignee'],
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const sharedDir = join(dir, '.shared');
    await mkdir(sharedDir, { recursive: true });

    const todosPath = join(sharedDir, 'TODOS.md');
    const existing = await readSharedFile('TODOS.md', dir);

    const id = `T-${Date.now()}`;
    const line = `- [ ] **${id}** ${params.task} (@${params.assignee})`;
    const header = existing ? '' : '# Todos\n\n';
    await writeFile(todosPath, header + existing + line + '\n', 'utf-8');

    return { success: true, id, task: params.task, assignee: params.assignee };
  },
};

export const todoList: ToolDefinition = {
  name: 'todo_list',
  description: 'List all shared tasks from TODOS.md.',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const content = await readSharedFile('TODOS.md', dir);
    if (!content) return { todos: [] };

    const todos = content
      .split('\n')
      .filter((line) => line.startsWith('- ['))
      .map((line) => {
        const done = line.startsWith('- [x]');
        const match = line.match(/\*\*(T-\d+)\*\*\s+(.+?)(?:\s+\(@(.+?)\))?$/);
        return {
          id: match?.[1] ?? 'unknown',
          task: match?.[2]?.trim() ?? line,
          assignee: match?.[3] ?? 'unassigned',
          done,
        };
      });

    return { todos };
  },
};

export const todoDone: ToolDefinition = {
  name: 'todo_done',
  description: 'Mark a task as done in TODOS.md.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Task ID (e.g. T-1234567890)' },
      projectDir: { type: 'string', description: 'Project directory (defaults to cwd)' },
    },
    required: ['id'],
  },
  async execute(params) {
    const dir = (params.projectDir as string) ?? process.cwd();
    const todosPath = join(dir, '.shared', 'TODOS.md');
    const content = await readSharedFile('TODOS.md', dir);
    if (!content) return { error: 'No TODOS.md found.' };

    const taskId = params.id as string;
    const updated = content.replace(
      new RegExp(`- \\[ \\] \\*\\*${taskId}\\*\\*`),
      `- [x] **${taskId}**`
    );

    if (updated === content) {
      return { error: `Task ${taskId} not found or already done.` };
    }

    await writeFile(todosPath, updated, 'utf-8');
    return { success: true, id: taskId };
  },
};

export const tools = [todoAdd, todoList, todoDone];
