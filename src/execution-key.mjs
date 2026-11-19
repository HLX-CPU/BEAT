import { createHash } from 'node:crypto';
export const executionAttemptKey = (runId, task) => createHash('sha256').update(JSON.stringify({ run: runId, task: task.id, attempt: task.attempts || task.attempt || 1 })).digest('hex');
