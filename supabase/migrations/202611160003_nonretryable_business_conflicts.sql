-- Business conflicts must terminate a request, not ask the transaction runner
-- to retry it. PostgREST 14 / Hasql retries SQLSTATE 40001 indefinitely, including
-- deterministic RAISE EXCEPTION guards. PT409 preserves the conflict HTTP status
-- and original message without pretending to be an engine serialization failure.
--
-- This exact allowlist is derived from the committed application migrations.
-- Every original body is fingerprinted; the only allowed difference is the
-- literal SQLSTATE on its explicit USING ERRCODE business guards. Unknown bodies
-- abort this migration. CREATE OR REPLACE retains the function OID, owner, ACL,
-- SECURITY DEFINER flag, search_path and every source/ownership/lease check.
-- Reapplying the migration accepts only the exact already-patched body.
do $nonretryable_business_conflicts$
declare
 target record; fn_oid oid; original text; patched text; definition text; matches integer;
 pattern constant text := $pattern$(using\s+errcode\s*=\s*)'40001'$pattern$;
begin
 for target in select * from (values
  ('loop_private.authored_conversation(uuid,text,jsonb)','19e378efd5e7e9a30e3c719a35f5d3e3','f00327b6de3d7e5936658963d3cf86be',2),
  ('loop_private.authored_history(uuid,public.authored_dialogue_calls,uuid[])','6ddd11f765328639418c74622866b553','747eb8b7373196a337b75510d6bc16c4',3),
  ('loop_private.authored_job(uuid,uuid,uuid,uuid,text)','ab96705ae51a4a698f8fad84f5724b4e','0e8598238368d3178a28045fd82417c3',1),
  ('loop_private.authored_lock_call(uuid,uuid,boolean)','822e633ab4eb59a1ab53ff030714a288','004964aace659d56c624f71a1bac1b2d',2),
  ('loop_private.authored_quote(uuid,uuid,jsonb,text,text)','b1acc369d63aa37a1d42ceff788d7656','51985f850f6c476fb6aa8c40bcd12df5',1),
  ('loop_private.authored_settled(uuid,uuid,text)','5ca55e60d9a7fa1695445cafe9b23469','b21ec338dece2cd8e1654456094a5d8a',1),
  ('loop_private.authored_shared(uuid,text,jsonb,bigint)','e261b5f226003b6ac0c146a95661d2ed','9d35adff4436104cd6b8e2290081e21b',1),
  ('loop_private.authored_source_clock(uuid,text,jsonb,uuid,text,text,text)','39c77fb0a26d685b9db656e07398f5a8','48aef16a7addafc4e448f4c9f5e12d28',1),
  ('loop_private.authored_source_stamp(uuid,text,uuid)','4a785ebb3b7d4f3f36493cae11f1f016','554a433dddbc8aa04fce1853487d2264',1),
  ('loop_private.authored_turn_lock(uuid,uuid,bigint,bigint,bigint)','ea3829950add2baaa7722825e61a0b74','18f6ce666083601dec69f68965008b57',2),
  ('loop_private.authored_validate_context(uuid,uuid,text,text,bigint,jsonb,jsonb,jsonb)','6a63168d5a18a5a0ac941966ba278f0e','e9b21cd9d20f70dd1ab2a5bdc47684a9',4),
  ('loop_private.authored_verify_sources(public.authored_dialogue_turns)','329517227ea9de463c926a6b35b55749','5f02afe2505c8f1685108affffd8048e',4),
  ('loop_private.complete_analysis_run(uuid,uuid,jsonb,text,uuid[])','e594862388e975832cba49af6c1c86e2','533310694980b42a7b44ca142aeb0a82',1),
  ('public.authored_dialogue_begin(uuid,uuid,bigint,bigint,bigint,uuid,text,uuid[],uuid[],bigint,bigint,jsonb,jsonb,text,text,jsonb,uuid[],numeric,jsonb)','6990dada2db2f4ea77c6a869f4b3d24c','b82ed92bb15a631f40f8c579c55558c5',7),
  ('public.authored_dialogue_checkpoint(uuid,uuid,bigint,bigint,bigint,uuid[],text,bigint,text,jsonb,uuid)','34d64e1e95f9e0317dd437ae7d6c3de0','00cb356bbc3f96779533ff0f99fd03a3',2),
  ('public.authored_dialogue_context(uuid,uuid,boolean,bigint,boolean)','e40d7cd520937d4f068a1425e7e6a5b5','0447b91a7a94a97c86f448da9dc07069',2),
  ('public.authored_dialogue_dispatch(uuid,uuid,bigint,bigint,bigint,bigint,uuid,uuid,text,uuid,uuid,jsonb)','63a358091bc252e0497609db1993de75','d0b115d4f399d1c27c83c4a9f90db19d',4),
  ('public.authored_dialogue_history(uuid,uuid,bigint,bigint,bigint,uuid[],uuid[],bigint)','3ca753158fb3bfa4a676552c17270328','4b0b0e6b2e021cbb573529fda6a40f85',1),
  ('public.authored_dialogue_playback(uuid,uuid,bigint,bigint,bigint,bigint,uuid,uuid[],uuid,bigint,text)','8d5ab76a2907d484abc74468e4eb38fc','414327f6308ab3d6b16d50ae15fb4a0b',4),
  ('public.authored_dialogue_state(uuid,uuid,bigint,bigint,bigint,bigint,uuid)','5c096a7b6f510a4a553886c4c1ff5afc','6c4b3d3fe6fc69a997c151e507549b72',3),
  ('public.complete_analysis_run(uuid,uuid,jsonb,text,uuid[])','1ba003f6d315ecb4b8b9a6c510d71062','5fc5ae6bdfa59eef12fbe8ecaad3080c',1),
  ('public.complete_conversation_memory(uuid,uuid,bigint,text,text,jsonb,text)','650459465ee0448e1a9b6b3b80000f9b','e785aaa6fcd81926b75f62a742967c29',2),
  ('public.complete_run(uuid,uuid,jsonb)','10c026a8abebe365c6f8375299d69e02','47bf96eb9acdf18241a6b0943deb18aa',1),
  ('public.fail_conversation_memory(uuid,uuid,text,text,integer)','69c35ff2bf62039d19f7158d924b46c2','b4a44a8e3be52578dd8aa739ca60cb9b',1),
  ('public.record_conversation_playback(uuid,uuid[],uuid,uuid[],bigint)','58489706a771b61609bd49507e96aed3','4515c35cc857fb63e3a9717a5d5e6c9e',3),
  ('public.record_model_spend(uuid,uuid,jsonb,numeric,text)','35f4702f42af9b133460a9056d0676e1','cae80df65db70c15bef04423789f3511',1),
  ('public.report_post_call_task(uuid,uuid,text,text,integer)','52663b7389042ef0341226ca92cf14b2','2a2c0804f7d7efccd7286874f873e57f',1),
  ('public.reserve_model_spend(uuid,uuid,text,jsonb,numeric)','04b0fb8892353431f28b9330a30c3575','f5c77aec5c84b8197426f364263826de',1),
  ('public.review_bookmark(uuid,text,boolean,integer)','23d9852a5b8d6b652295af32bcb45ee6','88415fb1fbe43517b40c1ce09f787bdf',2)
 ) as expected(signature,old_md5,new_md5,expected_guards) loop
  fn_oid:=pg_catalog.to_regprocedure(target.signature);
  if fn_oid is null then
   raise exception 'BUSINESS_CONFLICT_FUNCTION_MISSING: %',target.signature using errcode='PT409';
  end if;
  select p.prosrc into original from pg_catalog.pg_proc p
   join pg_catalog.pg_language l on l.oid=p.prolang where p.oid=fn_oid and l.lanname='plpgsql';
  if original is null then
   raise exception 'BUSINESS_CONFLICT_LANGUAGE_CHANGED: %',target.signature using errcode='PT409';
  end if;
  if pg_catalog.md5(original)=target.new_md5 then continue;end if;
  if pg_catalog.md5(original)<>target.old_md5 then
   raise exception 'BUSINESS_CONFLICT_SOURCE_CHANGED: %',target.signature using errcode='PT409';
  end if;
  select count(*) into matches from pg_catalog.regexp_matches(original,pattern,'gi');
  patched:=pg_catalog.regexp_replace(original,pattern,$replace$\1'PT409'$replace$,'gi');
  if matches<>target.expected_guards or pg_catalog.md5(patched)<>target.new_md5 then
   raise exception 'BUSINESS_CONFLICT_PATCH_CHANGED: %',target.signature using errcode='PT409';
  end if;
  definition:=pg_catalog.pg_get_functiondef(fn_oid);
  execute pg_catalog.regexp_replace(definition,pattern,$replace$\1'PT409'$replace$,'gi');
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid=fn_oid)<>target.new_md5 then
   raise exception 'BUSINESS_CONFLICT_RESULT_CHANGED: %',target.signature using errcode='PT409';
  end if;
 end loop;
end;
$nonretryable_business_conflicts$;
