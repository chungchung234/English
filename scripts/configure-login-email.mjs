// Configure code-email content only. SMTP accounts, credentials, and auth
// methods are deliberately absent from the PATCH payload.
const ref = process.env.SUPABASE_PROJECT_REF || 'domkmxmwmihcfadophfg';
const token = process.env.SUPABASE_ACCESS_TOKEN;
class SetupError extends Error {}

// Never print raw provider errors: validation may echo an existing SMTP
// address, credential, or config. Emit only known field names and fixed rules.
export function validationSummary(value) {
  const text = JSON.stringify(value).slice(0, 32_000);
  const fields = [...new Set(text.match(/\b(?:site_url|uri_allow_list|mailer_subjects_[a-z_]+|mailer_templates_[a-z_]+|smtp_(?:admin_email|host|port|user|pass|sender_name|max_frequency)|external_email_enabled)\b/g) || [])];
  const rules = [
    [/must be (?:an? )?(?:valid )?email|invalid email|email.*invalid/i, 'invalid email format'],
    [/must be (?:an? )?(?:valid )?url|invalid url/i, 'invalid URL format'],
    [/must be (?:an? )?string/i, 'string required'],
    [/must be (?:an? )?(?:number|integer)/i, 'number required'],
    [/must be (?:an? )?boolean/i, 'boolean required'],
    [/should not be empty|must not be empty|is required|missing required/i, 'required value missing'],
    [/should not exist|not allowed|unknown (?:field|property)|unrecognized/i, 'unsupported field or value'],
    [/ascii|latin/i, 'character set restriction'],
    [/template.*(?:invalid|parse|syntax)|(?:invalid|parse|syntax).*template/i, 'template syntax validation'],
    [/smtp.*(?:missing|required|incomplete)|(?:missing|required|incomplete).*smtp/i, 'existing SMTP configuration incomplete'],
    [/too (?:long|large)|maximum length|must be shorter/i, 'size restriction'],
    [/rate limit|too many requests/i, 'provider rate limit'],
    [/permission|not authorized|forbidden|access denied/i, 'provider authorization restriction'],
    [/validat|bad request|invalid/i, 'provider validation failed'],
  ].filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  return `fields=${fields.join(',') || 'not specified'}; rules=${rules.join(',') || 'unclassified provider validation'}`;
}

async function main() {
  if (!token) throw new SetupError('Provider authorization is required.');
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new SetupError('A valid project reference is required.');
  const endpoint = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;padding:24px;max-width:440px"><h1 style="font-size:24px">시시콜콜 로그인 코드</h1><p>영어 연습을 이어가려면 아래 코드를 로그인 화면에 입력해 주세요.</p><p style="font-size:32px;letter-spacing:6px;font-weight:700">{{ .Token }}</p><p>로그인을 요청하지 않으셨다면 이 메일을 무시하세요.</p></div>';
  const desired = {
    site_url: 'https://chungchung234.github.io/English/',
    mailer_subjects_magic_link: '[시시콜콜] 로그인 인증코드',
    mailer_subjects_confirmation: '[시시콜콜] 가입 인증코드',
    mailer_templates_magic_link_content: html,
    mailer_templates_confirmation_content: html,
  };
  async function call(method, body) {
    const response = await fetch(endpoint, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      let detail = {};
      try { detail = await response.json(); } catch { /* Never echo non-JSON error bodies. */ }
      throw new SetupError(`Auth template ${method} HTTP ${response.status}; ${validationSummary(detail)}`);
    }
    return response.json();
  }
  const before = await call('GET');
  await call('PATCH', desired);
  const after = await call('GET');
  for (const [key, value] of Object.entries(desired)) {
    if (after[key] !== value) throw new SetupError(`Template readback mismatch: ${key}`);
  }
  // Sensitive values stay in process memory. Compare them without logging.
  const smtpKeys = new Set([...Object.keys(before), ...Object.keys(after)].filter(key => key.startsWith('smtp_')));
  for (const key of smtpKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) throw new SetupError(`Existing SMTP setting changed during configuration: ${key}`);
  }
  console.log('::notice title=Email login prepared::시시콜콜 login and signup code templates verified by exact readback. Existing SMTP configuration unchanged.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof SetupError ? error.message : 'Provider request failed; details withheld to protect account configuration.';
    console.error(`::error title=Email template setup::${message}`);
    process.exitCode = 1;
  });
}
