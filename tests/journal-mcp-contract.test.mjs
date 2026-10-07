import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../netlify/functions/journal-mcp.mjs';

const toolNames=new Set(__test.tools.map(t=>t.name));

test('MCP exposes only scoped Journal and family tools including media lifecycle',()=>{
  for(const name of [
    'family_list_workspaces','journal_list_entries','journal_get_entry',
    'journal_create_entry','journal_update_entry','journal_set_archived','journal_mutate_block',
    'journal_reserve_media','journal_finalize_media','journal_update_media','journal_set_media_archived'
  ]) assert.equal(toolNames.has(name),true,name);
  assert.equal(toolNames.has('raw_sql'),false);
  assert.equal(toolNames.has('upload_media_binary'),false);
});

test('reserve media maps to GPT gateway without binary upload capability',()=>{
  const body=__test.mapTool('journal_reserve_media',{
    workspaceId:'11111111-1111-4111-8111-111111111111',
    entryId:'22222222-2222-4222-8222-222222222222',
    mimeType:'image/webp',caption:'公園'
  });
  assert.equal(body.command,'reserveMedia');
  assert.equal(body.mimeType,'image/webp');
  assert.equal(body.caption,'公園');
  assert.equal(body.workspaceId,'11111111-1111-4111-8111-111111111111');
});

test('media archive mapping remains soft-delete/restore semantics',()=>{
  const base={
    workspaceId:'11111111-1111-4111-8111-111111111111',
    entryId:'22222222-2222-4222-8222-222222222222',
    mediaId:'33333333-3333-4333-8333-333333333333',
    expectedVersion:2
  };
  assert.equal(__test.mapTool('journal_set_media_archived',{...base,archived:true}).command,'archiveMedia');
  assert.equal(__test.mapTool('journal_set_media_archived',{...base,archived:false}).command,'restoreMedia');
});
