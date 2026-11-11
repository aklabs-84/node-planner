// 문지기(Gate): AI Service Hub / 클래스로그AI에서 열어 준 입장권이 있을 때만 이 앱을 열어 준다.
//
// 동작
//  1) 주소에 ?t=입장권 이 있으면 → 도장(서명)·앱 이름·유효시간을 확인하고, 맞으면 "입장 완료" 쿠키를 주고
//     t 를 뺀 같은 주소로 다시 보낸다.
//  2) 유효한 "입장 완료" 쿠키가 있으면 그대로 통과.
//  3) 둘 다 없으면 "허브에서 열어 주세요" 화면(401).
//
// 환경변수 (Vercel 프로젝트에 등록)
//  GATE_PUBLIC_KEYS   입장권 도장을 확인하는 공개키(쉼표로 여러 개). 비어 있으면 문지기 "설치 안 됨"(예전처럼 누구나 열림)
//  GATE_APP_ID        이 앱의 이름표 = 허브에 등록된 이 앱의 id. 입장권에 적힌 앱 이름과 같아야 통과
//  GATE_COOKIE_SECRET "입장 완료" 쿠키에 도장 찍을 이 앱 전용 비밀 글자 (길고 무작위로)
//  AISERVICEHUB_BASE_URL  허브 주소(이미 다른 용도로 등록돼 있음). 문지기가 "지금 켜져 있어?"를 허브에 물어볼 때도 씀
//  GATE_HUB_URL       (선택) AISERVICEHUB_BASE_URL 대신 쓸 허브 주소
//
// 켜기/끄기: 허브의 앱 수정 화면 스위치가 진짜 스위치. 문지기는 허브에 물어본 답을 60초 기억한다.
//  - 허브가 "꺼짐"이라고 하면 입장권 없이도 열림
//  - 허브가 답이 없으면 마지막으로 기억한 답을 쓰고, 한 번도 못 받았으면 "켜짐"(막는 쪽)으로 본다
//
// 앱에는 도장을 "확인"하는 공개키만 있다. 입장권을 "만드는" 비밀키는 허브·클래스로그AI 서버에만 있다.
import { next } from '@vercel/functions';

const COOKIE_NAME = 'gate_ok';
const COOKIE_MAX_AGE = 8 * 60 * 60; // 8시간 (수업 하루 동안)
const MAX_TICKET_LIFETIME = 15 * 60; // 입장권 유효시간이 이보다 길게 적혀 있으면 거절
const CLOCK_SKEW = 30; // 서버 시계 차이 허용(초)
const STATUS_TTL_MS = 60 * 1000; // 허브 답을 기억하는 시간
const STATUS_TIMEOUT_MS = 2000; // 허브가 이보다 늦게 답하면 기다리지 않음

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64uToBytes = (s) => Uint8Array.from(Buffer.from(String(s), 'base64url'));
const bytesToB64u = (buf) => Buffer.from(buf).toString('base64url');

// ---- 입장권 확인 -----------------------------------------------------------
async function verifyTicket(ticket, appId, publicKeys) {
  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sigB64] = parts;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64uToBytes(payloadB64)));
  } catch {
    return false;
  }
  if (!payload || payload.v !== 1 || payload.app !== appId) return false;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return false;
  if (payload.exp < now - CLOCK_SKEW) return false; // 만료
  if (payload.iat > now + CLOCK_SKEW) return false; // 미래에 만든 입장권
  if (payload.exp - payload.iat > MAX_TICKET_LIFETIME) return false; // 너무 오래 쓰는 입장권

  const data = enc.encode(payloadB64);
  const sig = b64uToBytes(sigB64);
  for (const k of publicKeys) {
    try {
      const key = await crypto.subtle.importKey('raw', b64uToBytes(k), 'Ed25519', false, ['verify']);
      if (await crypto.subtle.verify('Ed25519', key, sig, data)) return true;
    } catch {
      /* 이 열쇠로는 확인 못 함 → 다음 열쇠 */
    }
  }
  return false;
}

// ---- "입장 완료" 쿠키 ------------------------------------------------------
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeCookieValue(secret, appId) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  const body = bytesToB64u(enc.encode(JSON.stringify({ app: appId, exp })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${bytesToB64u(sig)}`;
}

async function verifyCookieValue(value, secret, appId) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2) return false;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uToBytes(parts[1]), enc.encode(parts[0]));
    if (!ok) return false;
    const p = JSON.parse(dec.decode(b64uToBytes(parts[0])));
    return p.app === appId && typeof p.exp === 'number' && p.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// ---- 허브에 "지금 켜져 있어?" 묻기 (60초 기억) ---------------------------
let statusCache = null; // { on: boolean, at: number }
let statusInflight = null; // 동시에 여러 명이 와도 허브에는 한 번만 묻는다

async function gateIsOn(hubUrl, appId) {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.on;
  if (!statusInflight) {
    statusInflight = (async () => {
      try {
        const res = await fetch(`${hubUrl.replace(/\/$/, '')}/api/gate/status?app=${encodeURIComponent(appId)}`, {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = await res.json();
        if (typeof body.on !== 'boolean') throw new Error('bad body');
        statusCache = { on: body.on, at: Date.now() };
      } catch (err) {
        console.error('gate status check failed:', err && err.message);
        // 못 받으면 마지막 기억을 쓰되, 다음 요청에서 다시 묻도록 시간은 조금만 연장
        statusCache = { on: statusCache ? statusCache.on : true, at: Date.now() - STATUS_TTL_MS + 10 * 1000 };
      } finally {
        statusInflight = null;
      }
    })();
  }
  await statusInflight;
  return statusCache.on;
}

// ---- 안내 화면 -------------------------------------------------------------
function blockedPage(hubUrl) {
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>허브에서 열어 주세요</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f1;color:#1d1d1b;font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:420px;margin:24px;padding:32px 28px;background:#fff;border:1px solid #deddd6;border-radius:12px}
h1{margin:0 0 12px;font-size:22px;line-height:1.4}
p{margin:0 0 20px;font-size:16px;line-height:1.7;color:#4a4a45}
a{display:inline-block;margin:0 8px 8px 0;padding:12px 18px;border-radius:8px;background:#1d1d1b;color:#fff;text-decoration:none;font-weight:700;font-size:16px}
a.sub{background:#fff;color:#1d1d1b;border:1px solid #1d1d1b}
</style></head><body><main>
<h1>이 앱은 AI Service Hub나<br>클래스로그AI에서 열어야 해요</h1>
<p>주소를 직접 입력하거나 저장해 둔 주소로는 열리지 않아요. 아래 버튼으로 들어가서 이 앱을 다시 눌러 주세요.</p>
<a href="${hubUrl}">AI Service Hub로 가기</a>
<a class="sub" href="https://classlog-ai.vercel.app/">클래스로그AI로 가기</a>
</main></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

// ---- 문지기 본체 -----------------------------------------------------------
export default async function middleware(request) {
  const publicKeys = (process.env.GATE_PUBLIC_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (publicKeys.length === 0) return next(); // 문지기 꺼짐

  const appId = process.env.GATE_APP_ID;
  const secret = process.env.GATE_COOKIE_SECRET;
  if (!appId || !secret) {
    // 설정이 덜 된 상태: 열어 두면 막은 줄 알고 착각하므로 닫는다
    console.error('gate misconfigured: GATE_APP_ID / GATE_COOKIE_SECRET 필요');
    return new Response('Gate is not configured', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  const hubUrl = process.env.GATE_HUB_URL || process.env.AISERVICEHUB_BASE_URL || 'https://ai-service-hub.vercel.app';

  // 허브 스위치가 꺼져 있으면 예전처럼 누구나 열림
  if (!(await gateIsOn(hubUrl, appId))) return next();

  const url = new URL(request.url);

  // 1) 입장권으로 들어온 경우
  const ticket = url.searchParams.get('t');
  if (ticket) {
    if (await verifyTicket(ticket, appId, publicKeys)) {
      url.searchParams.delete('t');
      const cookie = await makeCookieValue(secret, appId);
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.pathname + url.search,
          'Set-Cookie': `${COOKIE_NAME}=${cookie}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return blockedPage(hubUrl);
  }

  // 2) 이미 입장한 브라우저
  if (await verifyCookieValue(readCookie(request, COOKIE_NAME), secret, appId)) {
    return next();
  }

  // 3) 입장권도 쿠키도 없음
  return blockedPage(hubUrl);
}
