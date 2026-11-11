"""Drain a bounded number of post-call tasks without a browser or new secrets.

The existing deployment credential obtains this project's existing server key
in memory. Neither credential, provider body nor learner data is printed.
"""
import json
import os
import re
import urllib.error
import urllib.request
from deploy import management_request


def drain(ref, token, maximum=4):
    if not re.fullmatch(r'[a-z0-9]{20}', ref) or not token or not 1 <= maximum <= 8:
        raise SystemExit('Valid project authorization and a bounded task count are required.')
    schema = management_request(ref, token, 'database/query', 'POST', {
        'query': "select to_regprocedure('public.claim_post_call_task()') is not null as ready"})
    if not schema or not schema[0].get('ready'):
        print('Background schema is not deployed; no work was claimed.')
        return
    keys = management_request(ref, token, 'api-keys?reveal=true')
    server_key = next((item.get('api_key') for item in keys if item.get('name') == 'service_role'), None)
    if not server_key:
        raise SystemExit('The project server credential is unavailable; no work was claimed.')
    for _ in range(maximum):
        req = urllib.request.Request(
            f'https://{ref}.supabase.co/functions/v1/coach/background-work', data=b'{}',
            headers={'Authorization': 'Bearer ' + server_key, 'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                print('Background endpoint rollout is pending; no new request will be made.')
                return
            raise SystemExit(f'Background request failed (HTTP {error.code}); no provider body printed.')
        except (urllib.error.URLError, TimeoutError):
            raise SystemExit('Background response was not confirmed. The server lease protects the next scheduled attempt.')
        if not isinstance(result, dict):
            raise SystemExit('Background response could not be verified; no response body printed.')
        status = result.get('status')
        if status not in ('idle', 'ready', 'retry_wait', 'blocked', 'exhausted', 'cancelled', 'superseded'):
            raise SystemExit('Background response could not be verified; no response body printed.')
        kind = result.get('kind') if result.get('kind') in ('session', 'handoff') else 'none'
        print(f'Post-call worker: status={status}, kind={kind}')
        if status == 'idle':
            return


if __name__ == '__main__':
    drain(os.environ.get('SUPABASE_PROJECT_REF', ''), os.environ.get('SUPABASE_ACCESS_TOKEN', ''),
          int(os.environ.get('BACKGROUND_MAX_REQUESTS', '4')))
