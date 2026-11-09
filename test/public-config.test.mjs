import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validatePublicConfig} from '../src/public-config.mjs';
test('hosted app accepts only public Supabase configuration',()=>{
 const url='https://project-ref.supabase.co';
 assert.deepEqual(validatePublicConfig(url,'sb_publishable_example'),{url,key:'sb_publishable_example'});
 const jwt=role=>`header.${btoa(JSON.stringify({role}))}.signature`;
 assert.equal(validatePublicConfig(url,jwt('anon')).key,jwt('anon'));
 for(const secret of ['sk-secret','sb_secret_private',jwt('service_role'),jwt('authenticated')])assert.throws(()=>validatePublicConfig(url,secret));
 for(const address of ['http://project.supabase.co','https://evil.example','https://project.supabase.co.evil.example','https://project.supabase.co/path','https://user:pass@project.supabase.co'])assert.throws(()=>validatePublicConfig(address,'sb_publishable_example'));
});
