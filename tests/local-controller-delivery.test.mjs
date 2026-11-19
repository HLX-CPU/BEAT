import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {partitionExecutionArtifacts} from '../src/queue-runner.mjs';

test('controller checkpoint is preserved as evidence without adding a customer delivery obligation', () => {
  const cwd=path.resolve('workspace');
  const checkpoint=path.join(cwd,'.beat-control','R250','task-1','checkpoint.json');
  const customer={path:path.join(cwd,'proof.txt')};
  const internal={path:checkpoint};
  const other={path:path.join(cwd,'checkpoint.json')};
  const split=partitionExecutionArtifacts(cwd,{files:['proof.txt','checkpoint.json']},[customer,internal,other],checkpoint);
  assert.deepEqual(split.artifacts,[customer,other]);
  assert.deepEqual(split.internalArtifacts,[internal]);
  assert.deepEqual(partitionExecutionArtifacts(cwd,{files:[checkpoint]},[internal],checkpoint).artifacts,[internal]);
  assert.deepEqual(partitionExecutionArtifacts(cwd,{outputRefs:[{path:checkpoint}]},[internal],checkpoint).artifacts,[internal]);
});
