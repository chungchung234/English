"""Deploy schema through HTTPS Management API and function through pinned CLI.
No database port, local Docker service, or long-running application server.
Requires provider authorization; never prints tokens or HTTP response bodies.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent

def migration_sql(source: str) -> str:
    digest = hashlib.sha256(source.encode()).hexdigest()
    # The complete migration and its marker commit atomically. A changed existing
    # migration is refused; future schema changes must be separate migrations.
    literal = source.replace("'", "''")
    return f"""begin;
select pg_advisory_xact_lock(782410639);
create schema if not exists loop_private;
revoke all on schema loop_private from public, anon, authenticated;
create table if not exists loop_private.migrations(version text primary key, sha256 text not null);
do $loop_setup$
declare existing text;
begin
select sha256 into existing from loop_private.migrations where version='202611090001';
if existing is not null and existing <> '{digest}' then
raise exception 'Existing migration checksum differs; create a new migration';
end if;
if existing is null then
execute '{literal}';
insert into loop_private.migrations values ('202611090001','{digest}');
end if;
end $loop_setup$;
commit;"""

def management_request(ref, token, path, method='GET', payload=None):
    request=urllib.request.Request(
        f'https://api.supabase.com/v1/projects/{ref}/{path}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method=method)
    try:
        with urllib.request.urlopen(request,timeout=90) as response:
            data=response.read()
            return json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        raise SystemExit(f'Supabase {path.split("/")[0]} request failed (HTTP {error.code}). Check deployment token permissions; no provider response printed.')
    except urllib.error.URLError:
        raise SystemExit('Supabase management could not connect. Check destination access and provider availability.')

def main():
    ref = os.environ.get('SUPABASE_PROJECT_REF', '')
    token = os.environ.get('SUPABASE_ACCESS_TOKEN', '')
    if not re.fullmatch(r'[a-z0-9]{20}', ref):
        raise SystemExit('SUPABASE_PROJECT_REF must be the 20-character project reference.')
    if not token:
        raise SystemExit('SUPABASE_ACCESS_TOKEN is missing. Supply it through secure environment settings.')
    if '--apply' not in sys.argv:
        print('Preflight passed. --apply deploys the database migration and coach function.')
        return
    metadata=management_request(ref,token,'secrets')
    if not isinstance(metadata,list):
        raise SystemExit('Could not verify the function secret names.')
    names={item.get('name') for item in metadata}
    if 'OPENAI_API_KEY' not in names:
        raise SystemExit('Set OPENAI_API_KEY in the project Edge Functions Secrets before deploying.')
    if 'ALLOWED_ORIGINS' not in names:
        origin=os.environ.get('PUBLIC_SITE_ORIGIN','https://chungchung234.github.io')
        import urllib.parse
        parsed=urllib.parse.urlsplit(origin)
        if parsed.scheme!='https' or parsed.path or parsed.query or parsed.fragment or parsed.username or not parsed.hostname:
            raise SystemExit('PUBLIC_SITE_ORIGIN must be a complete HTTPS origin without a path.')
        management_request(ref,token,'secrets','POST',[{'name':'ALLOWED_ORIGINS','value':origin}])
        print('Configured the public site origin. Existing configured origins are preserved.')
    source = (ROOT/'supabase/migrations/202611090001_init.sql').read_text()
    management_request(ref,token,'database/query','POST',{'query':migration_sql(source)})
    print('Database migration committed or verified already applied.')
    cli_env = {**os.environ, 'SUPABASE_HOME': str(ROOT.parent/'.supabase-cli')}
    # Provider secrets must already be configured in the dashboard. The proxy
    # OpenAI binding is deliberately NOT forwarded into another provider.
    result=subprocess.run([str(ROOT/'node_modules/.bin/supabase'), 'functions', 'deploy', 'coach',
        '--remote='+ref, '--use-api', '--no-verify-jwt', '--yes'], cwd=ROOT, env=cli_env)
    if result.returncode:
        raise SystemExit('Function deployment failed; the DB migration is retained and safe to retry.')
    print('Coach function deployed. Runtime origin/auth/voice/backup acceptance checks remain required.')

if __name__ == '__main__':
    main()
