import test from 'node:test';
import assert from 'node:assert/strict';
import shell from '../public/journal-shell.mjs';

test('Journal shell state changes are explicit and idempotent',async()=>{
  let openEvents=0,tabEvents=0,pendingEvents=0,rendered=0;
  const off=[
    shell.on('open',()=>openEvents++),
    shell.on('tab',()=>tabEvents++),
    shell.on('pending',()=>pendingEvents++),
    shell.on('rendered',()=>rendered++)
  ];
  shell.setOpen(false);
  shell.setOpen(true);
  shell.setOpen(true);
  shell.setTab('history');
  shell.setTab('history');
  shell.setPending(3);
  shell.setPending(3);
  shell.setSelectedEntryId('entry-1');
  shell.rendered({open:true,selectedEntryId:'entry-1'});
  assert.equal(openEvents,1);
  assert.equal(tabEvents,1);
  assert.equal(pendingEvents,1);
  assert.equal(rendered,1);
  assert.deepEqual(shell.snapshot().open,true);
  assert.equal(shell.snapshot().tab,'history');
  assert.equal(shell.snapshot().pending,3);
  assert.equal(shell.snapshot().selectedEntryId,'entry-1');
  off.forEach(fn=>fn());
});

test('Journal shell commands have one explicit owner',async()=>{
  let opened=0,closed=0;
  shell.registerCommands({open:()=>{opened++;shell.setOpen(true);return true;},close:()=>{closed++;shell.setOpen(false);return true;}});
  assert.equal(await shell.open(),true);
  assert.equal(await shell.close(),true);
  assert.equal(opened,1);
  assert.equal(closed,1);
  assert.equal(shell.snapshot().open,false);
});
