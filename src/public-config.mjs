// Only public Supabase connection details may be shipped to a browser.
export function validatePublicConfig(url, key) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(u.hostname) || u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw Error('올바른 Supabase 프로젝트 URL이 필요합니다.');
  if (typeof key !== 'string' || key.startsWith('sb_secret_') || key.startsWith('sk-')) throw Error('비밀 키는 공개 웹 설정에 사용할 수 없습니다.');
  if(key.startsWith('sb_publishable_')&&!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key))throw Error('공개 키 형식이 올바르지 않습니다.');
  if (!key.startsWith('sb_publishable_')) {
    let claims; try { claims = JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { throw Error('공개 publishable 또는 anon 키가 필요합니다.'); }
    if (claims.role !== 'anon') throw Error('anon 공개 키만 사용할 수 있습니다.');
  }
  return { url:u.origin, key };
}
