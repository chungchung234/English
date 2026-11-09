// Reproducible SQL retrieval/policy evaluation. Vectors are synthetic: this
// measures retrieval mechanics, not the semantic accuracy of an embedding model.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function evaluateMemory() {
  const db = new PGlite({ extensions: { pgcrypto } });
  const user = randomUUID(), other = randomUUID(), model = 'text-embedding-3-small';
  const vector = axis => Array.from({ length: 512 }, (_, i) => i === axis ? 1 : 0);
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on function auth.uid() to public;`);
    const directory = new URL('../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file, directory), 'utf8'));
    await db.query("insert into auth.users values ($1,'evaluation-a@example.invalid',now()),($2,'evaluation-b@example.invalid',now())", [user, other]);
    await db.exec("insert into loop_private.approved_emails values ('evaluation-a@example.invalid'),('evaluation-b@example.invalid')");
    async function seed(owner, companion, summary, age, goal) {
      const session = randomUUID(), event = randomUUID(), analysis = randomUUID();
      const time = new Date(Date.now() - age * 86400000).toISOString();
      await db.query("insert into public.sessions(id,user_id,companion_id,scenario,status,created_at,ended_at) values ($1,$2,$3,'Everyday conversation','ended',$4,$4)", [session, owner, companion, time]);
      await db.query("insert into public.transcript_events(id,user_id,session_id,event_key,speaker,text,timestamp) values ($1,$2,$3,'evaluation','user',$4,$5)", [event, owner, session, summary, time]);
      const content = { summary, strengths: [], corrections: [], practice: [], next_scenario: 'Continue', memory_facts: goal ? [{ key: 'goal', value: goal, quote: summary, evidence_ids: [event] }] : [] };
      await db.query("insert into public.analyses(id,user_id,session_id,kind,content,model,source_event_ids,created_at) values ($1,$2,$3,'session',$4,'evaluation',$5,$6)", [analysis, owner, session, JSON.stringify(content), [event], time]);
      return { session, analysis };
    }
    const target = await seed(user, 'alex', 'Preparing a concise introduction for a hiring conversation. sunflower', 200, 'Speak confidently in interviews');
    for (let i = 0; i < 18; i++) await seed(user, 'alex', `Discussed an ordinary meal and a neighborhood walk ${i}.`, i + 1);
    const foreign = await seed(other, 'alex', 'Private interview preparation', 1);
    const otherCompanion = await seed(user, 'mia', 'Mia-only interview preparation', 1);
    await db.exec('set role service_role');
    async function context(owner, companion, text, embedding = null, embeddingModel = model) {
      const { rows } = await db.query('select public.memory_context($1,$2,$3,$4::real[],$5,12) as result', [owner, companion, text, embedding, embeddingModel]);
      return rows[0].result;
    }
    async function index(owner, companion, relevant) {
      let count = 0;
      for (let batch = 0; batch < 32; batch++) {
        const { rows } = await db.query('select * from public.memory_index_candidates($1,$2,$3,4)', [owner, companion, model]);
        if (!rows.length) return count;
        for (const row of rows) {
          const { rows: stored } = await db.query('select public.memory_store_embedding($1,$2,$3,$4,$5,$6::real[],$7) as result', [owner, companion, row.analysis_id, model, row.content_hash, vector(row.analysis_id === relevant ? 0 : 1), row.revision]);
          if (stored[0].result) count++;
        }
      }
      throw Error('Synthetic evaluation indexing did not terminate within its batch limit.');
    }
    const baseline = await context(user, 'alex', '다음 채용 면담에서 자기소개하기');
    check('old_paraphrase_absent_from_keyword_recent_baseline', !baseline.memories.some(row => row.id === target.analysis));
    const indexed = await index(user, 'alex', target.analysis);
    await index(other, 'alex', foreign.analysis);
    await index(user, 'mia', otherCompanion.analysis);
    const hybrid = await context(user, 'alex', '다음 채용 면담에서 자기소개하기', vector(0));
    const rank = hybrid.memories.findIndex(row => row.id === target.analysis) + 1;
    check('synthetic_paraphrase_recalled_at_12', rank > 0 && rank <= 12);
    check('hybrid_preserves_companion_and_account_isolation', hybrid.memories.every(row => row.user_id === user && ![foreign.analysis, otherCompanion.analysis].includes(row.id)));
    const lexical = await context(user, 'alex', 'sunflower');
    check('exact_keyword_survives_without_embeddings', lexical.memories.some(row => row.id === target.analysis));
    const mismatch = await context(user, 'alex', '다음 채용 면담에서 자기소개하기', vector(0), 'another-embedding-model');
    check('different_embedding_model_not_reused', !mismatch.memories.some(row => row.id === target.analysis));
    const manage = async (action, key = null, value = null, session = null) => (await db.query('select public.memory_manage($1,$2,$3,$4,$5,$6) as result', [user, 'alex', action, key, value, session])).rows[0].result;
    const before = hybrid.revision;
    await manage('excludeSession', null, null, target.session);
    const excluded = await context(user, 'alex', 'sunflower', vector(0));
    check('excluded_session_removed_from_hits_and_profile', !excluded.memories.some(row => row.id === target.analysis) && !excluded.facts.some(fact => fact.value === 'Speak confidently in interviews'));
    check('policy_mutation_advances_revision', Number(excluded.revision) > Number(before));
    await manage('restoreSession', null, null, target.session);
    const restored = await context(user, 'alex', 'sunflower', vector(0));
    check('explicit_session_restore_reenables_search', restored.memories.some(row => row.id === target.analysis));
    await manage('setFact', 'goal', 'Give clear conference presentations');
    const edited = await context(user, 'alex', 'sunflower', vector(0));
    check('manual_fact_survives_zero_eligible_hits', edited.facts.some(fact => fact.key === 'goal' && fact.value === 'Give clear conference presentations') && edited.memories.length === 0);
    await manage('forgetFact', 'goal');
    const forgotten = await context(user, 'alex', 'sunflower', vector(0));
    check('forget_tombstone_prevents_old_fact_and_text_recall', forgotten.facts.some(fact => fact.key === 'goal' && fact.forgotten && fact.value === '') && forgotten.memories.length === 0);
    return {
      mode: 'synthetic_vectors_actual_sql', semantic_model_quality_measured: false,
      scope: 'isolated local PostgreSQL fixtures; no production user data or API calls',
      indexed_fixtures: indexed,
      synthetic_recall_at_12: rank > 0 && rank <= 12 ? 1 : 0,
      synthetic_target_rank: rank || null,
      passed: checks.filter(item => item.passed).length, total: checks.length,
      checks,
    };
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await evaluateMemory();
    await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
    await writeFile(new URL('../test-results/memory-evaluation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.passed !== report.total) process.exitCode = 1;
  } catch (error) { console.error('Memory evaluation failed:', error.message); process.exitCode = 1; }
}
