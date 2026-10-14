import test from 'node:test';
import assert from 'node:assert/strict';
import {submissionStatus} from '../packages/messaging/submission-status.mjs';

test('submission status accepts two navigation links without executable action fields', () => {
  const value = {type:'success', message:'Saved.', actions:[
    {label:'View result', href:'https://app.example/result'},
    {label:'Help', href:'https://help.example/'}
  ]};
  assert.deepEqual(submissionStatus(value), value);
  for (const actions of [
    [...value.actions, {label:'Third', href:'https://app.example/third'}],
    [{label:'Run', href:'javascript:alert(1)'}],
    [{label:'Open', href:'https://user:password@app.example/'}],
    [{label:'Submit', href:'https://app.example/', method:'POST'}],
    [{label:'Callback', href:'https://app.example/', callback:'run'}]
  ]) assert.throws(() => submissionStatus({...value, actions}));
});
