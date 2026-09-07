import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCsv, todayLocal, entryLabel, queueRecord, listOptions } from '../public/journal-ui.mjs';

test('splitCsv trims, deduplicates and accepts Chinese comma',()=>{
  assert.deepEqual(splitCsv('六福村, 第一次，六福村, 雙寶'),['六福村','第一次','雙寶']);
});

test('todayLocal formats local calendar date without UTC drift',()=>{
  const d=new Date(2026,8,7,23,59,0);
  assert.equal(todayLocal(d),'2026-09-07');
});

test('entryLabel prefers title then summary then fallback',()=>{
  assert.equal(entryLabel({title:' 六福村 ',summary:'內容'}),'六福村');
  assert.equal(entryLabel({summary:'今天第一次看到長頸鹿'}),'今天第一次看到長頸鹿');
  assert.equal(entryLabel({}),'未命名日誌');
});

test('queueRecord preserves mutation id and normalized write payload',()=>{
  const id='11111111-1111-4111-8111-111111111111';
  const q=queueRecord({entryDate:'2026-09-07',summary:'記一下',tags:['A'],participants:['B']},id,'2026-09-07T01:00:00.000Z');
  assert.equal(q.id,id);
  assert.equal(q.mutationId,id);
  assert.equal(q.input.entryDate,'2026-09-07');
  assert.equal(q.input.timezone,'Asia/Taipei');
  assert.deepEqual(q.input.tags,['A']);
  assert.deepEqual(q.input.participants,['B']);
});

test('listOptions keeps archived entries hidden by default and opt-in visible',()=>{
  assert.deepEqual(listOptions(false),{limit:100,includeArchived:false});
  assert.deepEqual(listOptions(true),{limit:100,includeArchived:true});
});