/**
 * 03_backend_server.js
 * ------------------------------------------------------------
 * Express 백엔드 서버
 *
 * 엔드포인트:
 *   POST /api/ask                  - 일반 질문 → RAG → Gemini 답변
 *   POST /api/codef/request-auth   - 코드에프 간편인증 1차 요청
 *   POST /api/codef/complete-auth  - 사용자 인증 완료 후 2차 요청 (보험 내역 조회)
 *   POST /api/analyze-portfolio    - 조회된 보험 → RAG → Gemini 종합 분석
 *   POST /api/contact              - 전문가 상담 신청 (연락처 수집)
 *
 * ⚠️ 본인인증 자동화는 의도적으로 구현하지 않습니다.
 *    사용자는 자기 휴대폰에서 카카오/PASS 앱을 직접 열어 인증해야 합니다.
 *    백엔드는 코드에프 표준 2-Way 흐름(요청 → 사용자 인증 → 완료 폴링)만 처리합니다.
 *
 * ⚠️ 운영 배포 전:
 *   1. HTTPS 적용
 *   2. CORS 화이트리스트 좁히기
 *   3. Rate-limit (express-rate-limit)
 *   4. 입력 검증 (zod 등)
 *   5. connectedId 영구 저장 (메모리 → DB)
 *   6. 로그/모니터링 (Sentry, Datadog 등)
 *   7. ISMS·신용정보법 준수 체계
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { Pinecone } from '@pinecone-database/pinecone';

const PORT = parseInt(process.env.PORT || '8787', 10);

// ---------- 환경변수 검증 ----------
const REQ_ENV = [
  'GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX', 'PINECONE_HOST',
  'CODEF_CLIENT_ID', 'CODEF_CLIENT_SECRET', 'CODEF_PUBLIC_KEY', 'CODEF_HOST',
];
for (const k of REQ_ENV) {
  if (!process.env[k]) console.warn(`⚠️ 환경변수 미설정: ${k} (해당 기능 동작 안 함)`);
}

// ---------- 클라이언트 ----------
const genai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const pinecone = process.env.PINECONE_API_KEY
  ? new Pinecone({ apiKey: process.env.PINECONE_API_KEY })
  : null;

const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-flash-latest';
const EMBED_DIM = parseInt(process.env.EMBED_DIM || '3072', 10);

// ============================================================
// 메모리 저장소 (POC) — 운영에선 DB로 교체
// ============================================================
const memStore = {
  // userKey -> { connectedId, insurers, createdAt, lastQueriedAt }
  users: new Map(),
  // 진행 중인 인증 요청 추적
  pendingAuths: new Map(),
  // 상담 신청
  contacts: [],
};

// ============================================================
// 구글시트 저장 (Apps Script 웹훅)
// GOOGLE_SHEETS_WEBHOOK_URL 이 설정돼 있으면 해당 URL로 POST.
// 미설정이면 조용히 건너뜀(서비스는 정상 동작).
// ============================================================
async function postToSheets(payload) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: process.env.SHEETS_WEBHOOK_SECRET || '',
        ...payload,
      }),
      redirect: 'follow',
    });
    const text = await res.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    if (!res.ok || parsed.ok === false) {
      console.warn('[Sheets] 저장 실패:', res.status, JSON.stringify(parsed).slice(0, 200));
      return { ok: false, status: res.status, body: parsed };
    }
    return { ok: true, body: parsed };
  } catch (e) {
    console.warn('[Sheets] 웹훅 호출 오류:', e.message);
    return { ok: false, error: e.message };
  }
}

function getOrCreateUserKey(req) {
  // 간이 식별: 헤더/쿠키. 운영에선 자체 로그인/세션으로 교체
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
  const ua = req.headers['user-agent'] || '?';
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);
}

// ============================================================
// CODEF 유틸
// ============================================================
function codefHost() {
  return (process.env.CODEF_HOST || 'https://development.codef.io').replace(/\/$/, '');
}

function codefOAuthHost() {
  // OAuth 토큰 발급은 비즈니스 API와 별도 도메인을 사용합니다.
  return (process.env.CODEF_OAUTH_HOST || 'https://oauth.codef.io').replace(/\/$/, '');
}

let cachedAccessToken = null;
let tokenExpiresAt = 0;

async function getCodefAccessToken() {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 30_000) {
    return cachedAccessToken;
  }
  const auth = Buffer
    .from(`${process.env.CODEF_CLIENT_ID}:${process.env.CODEF_CLIENT_SECRET}`)
    .toString('base64');
  const tokenUrl = `${codefOAuthHost()}/oauth/token`;
  console.log(`[CODEF] 토큰 요청: ${tokenUrl}`);
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: 'grant_type=client_credentials&scope=read',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CODEF 토큰 발급 실패: ${res.status} ${text}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`CODEF 토큰 응답 파싱 실패: ${text.slice(0, 200)}`); }
  if (!data.access_token) {
    throw new Error(`CODEF 토큰 없음: ${JSON.stringify(data).slice(0, 200)}`);
  }
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  console.log(`[CODEF] 토큰 발급 성공 (만료 ${data.expires_in || 3600}s)`);
  return cachedAccessToken;
}

// 코드에프는 사용자 입력(주민번호 일부·이름 등)을 RSA 공개키로 암호화하여 전송해야 함
function encryptForCodef(plain) {
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${process.env.CODEF_PUBLIC_KEY.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  return crypto
    .publicEncrypt(
      { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(plain, 'utf8'),
    )
    .toString('base64');
}

async function callCodef(path, body) {
  const token = await getCodefAccessToken();
  // ⚠️ CODEF 규칙: 요청 본문은 JSON을 URL인코딩해서 보내야 함.
  //    (암호화 base64의 '+','/','=' 가 인코딩 안 되면 CODEF가 공백 등으로 오해 → CF-04028)
  //    응답도 URL인코딩되어 오므로 아래에서 decodeURIComponent 한다.
  const res = await fetch(`${codefHost()}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: encodeURIComponent(JSON.stringify(body)),
  });
  const raw = await res.text();
  // 코드에프 응답은 URL-encoded JSON 형태
  const decoded = decodeURIComponent(raw);
  let parsed;
  try { parsed = JSON.parse(decoded); }
  catch { parsed = { rawResponse: decoded }; }
  return { status: res.status, body: parsed };
}

// ============================================================
// RAG 유틸
// ============================================================
async function embedQuery(text) {
  if (!genai) throw new Error('Gemini 미설정');
  const res = await genai.models.embedContent({
    model: EMBED_MODEL,
    contents: [{ parts: [{ text }] }],
    config: {
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: EMBED_DIM,
    },
  });
  const vec = res.embeddings?.[0]?.values || res.embedding?.values;
  if (!vec) throw new Error('임베딩 응답 비정상');
  return vec;
}

async function searchPinecone(queryVec, opts = {}) {
  if (!pinecone) { console.warn('[RAG] Pinecone 미설정 — 빈 결과로 진행'); return []; }
  if (!process.env.PINECONE_HOST || process.env.PINECONE_HOST.includes('test-xxxx')) {
    console.warn('[RAG] PINECONE_HOST가 placeholder. .env 업데이트 필요. 빈 결과로 진행.');
    return [];
  }
  try {
    const index = pinecone.index(process.env.PINECONE_INDEX, process.env.PINECONE_HOST);
    const result = await index.query({
      vector: queryVec,
      topK: opts.topK || 8,
      includeMetadata: true,
      filter: opts.filter,
    });
    return result.matches || [];
  } catch (e) {
    console.warn('[RAG] Pinecone 검색 실패, 빈 결과로 진행:', e.message);
    return [];
  }
}

function matchesToContext(matches) {
  return matches.map((m, i) => {
    const md = m.metadata || {};
    return `[${i+1}] (${md.insurer} - ${md.productName}, p.${md.page})\n${md.text}`;
  }).join('\n\n---\n\n');
}

// ----- Gemini 호출 재시도 헬퍼 -----
// 503(UNAVAILABLE), 429(RESOURCE_EXHAUSTED) 등 일시적 오류 시 지수 백오프로 재시도
// 모든 시도 실패 시 대체 모델로 fallback
const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function callGeminiWithRetry(makeCall, opts = {}) {
  const maxRetries = opts.maxRetries ?? 3;
  let lastError;

  // 1단계: 기본 모델로 재시도
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await makeCall(CHAT_MODEL);
    } catch (e) {
      lastError = e;
      const msg = e?.message || '';
      const retryable = /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|high demand|overloaded|temporarily/i.test(msg);
      if (!retryable || attempt === maxRetries - 1) break;
      const delay = Math.min(1500 * Math.pow(2, attempt), 8000); // 1.5s → 3s → 6s
      console.warn(`[Gemini] ${CHAT_MODEL} 재시도 ${attempt + 1}/${maxRetries} (${delay}ms 대기): ${msg.slice(0, 120)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // 2단계: 대체 모델로 fallback
  for (const fallbackModel of FALLBACK_MODELS) {
    if (fallbackModel === CHAT_MODEL) continue;
    try {
      console.warn(`[Gemini] 대체 모델 시도: ${fallbackModel}`);
      return await makeCall(fallbackModel);
    } catch (e) {
      lastError = e;
      console.warn(`[Gemini] ${fallbackModel} 실패: ${(e?.message || '').slice(0, 120)}`);
    }
  }

  // 모두 실패
  throw lastError || new Error('Gemini 모든 모델 호출 실패');
}

async function askGemini(systemPrompt, userPrompt, opts = {}) {
  if (!genai) throw new Error('Gemini 미설정');
  return await callGeminiWithRetry(async (model) => {
    const res = await genai.models.generateContent({
      model,
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + userPrompt }] },
      ],
      config: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    });
    const cand = res.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text || '';
    const finishReason = cand?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[Gemini] 답변이 ${finishReason}로 종료됨. 길이=${text.length}`);
    }
    return text;
  });
}

// Multi-turn 대화 (히스토리 포함)
async function chatGemini(systemPrompt, history, opts = {}) {
  if (!genai) throw new Error('Gemini 미설정');
  const contents = [];
  let systemInjected = false;
  for (const msg of history) {
    const role = msg.role === 'assistant' ? 'model' : msg.role;
    let text = msg.text || '';
    if (!systemInjected && role === 'user') {
      text = systemPrompt + '\n\n사용자 첫 질문: ' + text;
      systemInjected = true;
    }
    contents.push({ role, parts: [{ text }] });
  }
  if (!systemInjected) {
    contents.unshift({ role: 'user', parts: [{ text: systemPrompt }] });
  }
  return await callGeminiWithRetry(async (model) => {
    const res = await genai.models.generateContent({
      model,
      contents,
      config: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    });
    const cand = res.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text || '';
    const finishReason = cand?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[Gemini chat] 답변이 ${finishReason}로 종료. 길이=${text.length}`);
    }
    return text;
  });
}

// Vision (이미지·PDF 분석)
async function visionGemini(systemPrompt, userText, files, opts = {}) {
  if (!genai) throw new Error('Gemini 미설정');
  const parts = [];
  for (const f of files) {
    parts.push({ inlineData: { mimeType: f.mimeType, data: f.base64 } });
  }
  parts.push({ text: systemPrompt + '\n\n' + userText });
  return await callGeminiWithRetry(async (model) => {
    const res = await genai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: {
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 8192,
      },
    });
    const cand = res.candidates?.[0];
    const text = cand?.content?.parts?.[0]?.text || '';
    const finishReason = cand?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[Gemini vision] 답변이 ${finishReason}로 종료. 길이=${text.length}`);
    }
    return text;
  });
}

// ============================================================
// Express 앱
// ============================================================
const app = express();

// CORS — 정확 매칭(CORS_ORIGIN, 콤마 구분) + 정규식 매칭(CORS_ORIGIN_REGEX, 콤마 구분)
// 예) CORS_ORIGIN=https://bodoctor.com,https://www.bodoctor.com
//     CORS_ORIGIN_REGEX=^https://bodoctor-[a-z0-9-]+\.vercel\.app$
const corsOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',').map(s => s.trim()).filter(Boolean);
const corsPatterns = (process.env.CORS_ORIGIN_REGEX || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(p => { try { return new RegExp(p); } catch { return null; } })
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // 동일 origin / curl / 서버-사이드 호출은 origin이 비어있음 → 허용
    if (!origin) return cb(null, true);
    if (corsOrigins.includes('*')) return cb(null, true);
    if (corsOrigins.includes(origin)) return cb(null, true);
    if (corsPatterns.some(re => re.test(origin))) return cb(null, true);
    return cb(new Error('CORS 차단: ' + origin));
  },
  credentials: true,
}));
app.use(express.json({ limit: '15mb' })); // 이미지 base64 업로드 고려

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    gemini: !!genai,
    pinecone: !!pinecone,
    codef: !!process.env.CODEF_CLIENT_ID,
    time: new Date().toISOString(),
  });
});

// --------------------------------------------------------
// POST /api/ask — 일반 질문 → RAG → Gemini
// --------------------------------------------------------
// 보험 챗봇용 공통 시스템 프롬프트
const INSURANCE_SYSTEM = `당신은 보험 비교·진단 서비스 '보닥터'의 AI 상담원입니다. 한국 손해보험·생명보험에 정통합니다.

이 서비스의 목적은 단순 정보 제공이 아니라, 사용자가 (1) '내 보험 진단'으로 본인 가입내역을 분석받고, (2) 필요 시 '전문가 상담(보험설계사 매칭)'으로 연결되도록 돕는 것입니다. 모든 답변은 이 두 가지 행동으로 자연스럽게 이어지도록 작성하세요.

답변 원칙:
- 질문에는 정확하고 구체적으로 답하세요.
- 한국 보험 표준약관 및 시장 관행 기준으로 답하세요. 1~5세대 실손, 자기부담률, 비례보상, 면책, 비급여 차등제 등 핵심 개념을 적절히 활용하세요.
- 보험사 비교 시 객관적 기준(보험료, 자기부담률, 한도, 손해율, 청구 편의성 등)을 제시하세요.
- 어려운 용어는 쉽게 풀고, 마크다운(굵게·목록)을 적극 활용해 가독성을 높이세요.
- 너무 길게 늘어놓지 말고, 핵심을 먼저 말한 뒤 진단·상담으로 이어가세요.

피해야 할 것:
- "보험 추천", "가장 좋은 보험", "해지 추천" 같은 단정적 표현 금지. "검토 권유" 정도까지만.
- 의학적·법률적 단정 금지.
- 답변 끝에 정형화된 홍보 문구나 면책 안내 문장을 자동으로 덧붙이지 마세요. 질문에 대한 답으로 자연스럽게 끝맺습니다.`;

app.post('/api/ask', async (req, res) => {
  try {
    const { question, history } = req.body;
    // history: [{role:'user'|'assistant', text:'...'}] 옵션

    if (!question && (!history || history.length === 0)) {
      return res.status(400).json({ error: '질문이 없습니다' });
    }

    // 1) history가 있으면 multi-turn, 없으면 단발
    let answer;
    if (Array.isArray(history) && history.length > 0) {
      // 마지막에 새 질문 추가
      const fullHistory = [...history];
      if (question) fullHistory.push({ role: 'user', text: question });
      console.log(`[ask] multi-turn (${fullHistory.length}턴) "${(question || '').slice(0, 50)}..."`);
      answer = await chatGemini(INSURANCE_SYSTEM, fullHistory);
    } else {
      console.log(`[ask] "${question.slice(0, 60)}..."`);
      answer = await askGemini(INSURANCE_SYSTEM, question);
    }

    res.json({ answer });
  } catch (e) {
    console.error('[ask]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/analyze-upload — 업로드한 이미지·PDF 분석
// --------------------------------------------------------
// 입력: { files: [{ name, mimeType, base64 }], userNote (옵션) }
// 출력: { answer, extracted }
app.post('/api/analyze-upload', async (req, res) => {
  try {
    const { files, userNote } = req.body;
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '파일이 없습니다' });
    }

    // 총 크기 검증 (10MB 제한)
    const totalBytes = files.reduce((s, f) => s + (f.base64?.length || 0) * 0.75, 0);
    if (totalBytes > 10 * 1024 * 1024) {
      return res.status(413).json({ error: '파일 총 크기가 너무 큽니다 (10MB 제한)' });
    }

    console.log(`[analyze-upload] ${files.length}개 파일 분석 시작`);
    const visionParts = files
      .filter(f => /^image\/(png|jpe?g|webp|gif)$/i.test(f.mimeType) || f.mimeType === 'application/pdf')
      .map(f => ({ mimeType: f.mimeType, base64: f.base64 }));

    if (visionParts.length === 0) {
      return res.status(400).json({ error: '지원하는 파일 형식이 없습니다 (PNG/JPG/PDF만 가능)' });
    }

    const userText = `사용자가 본인의 보험증권 또는 가입내역을 업로드했습니다.

[사용자 메모]
${userNote || '(없음)'}

[해야 할 일]
1) 첨부된 이미지/PDF에서 다음 정보를 가능한 한 추출해주세요:
   - 보험사명
   - 상품명
   - 보험기간 / 갱신주기
   - 월 보험료
   - 주요 보장 항목 (실손/암/뇌·심장/사망/후유장해 등)
   - 자기부담률·한도(있다면)
2) 추출한 정보를 깔끔한 표로 정리해주세요.
3) 보장 측면에서 누락·중복 가능성, 갱신 시 보험료 부담, 비교 검토 포인트를 알려주세요.
4) 마지막에 사용자가 설계사나 전문가에게 물어볼 만한 후속 질문 3개를 제안해주세요.

주민등록번호, 주소, 전화번호 등 개인정보가 보여도 답변에 인용하지 마세요. 보험 정보만 사용하세요.`;

    const answer = await visionGemini(INSURANCE_SYSTEM, userText, visionParts);
    res.json({ answer });
  } catch (e) {
    console.error('[analyze-upload]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/codef/request-auth — 1차: 간편인증 요청
// --------------------------------------------------------
//
// 클라이언트가 사용자에게 받은 정보 (이름, 생년월일, 휴대폰, 통신사,
// 인증수단[카카오/PASS/네이버 등])를 그대로 전달합니다. 백엔드는
// 이 정보를 코드에프 공개키로 암호화해 1차 요청을 보내고,
// 코드에프가 사용자 휴대폰에 인증 요청을 발송합니다.
//
// 입력: { name, birthDate, phoneNo, telecom, authType, organization }
//   authType: '0'=카카오, '1'=PASS, '2'=삼성패스, '3'=KB모바일, '4'=페이코, '5'=네이버, '6'=신한
//   telecom: '0'=SKT, '1'=KT, '2'=LG U+, '3-5'=알뜰폰
//   organization: '0235'=손해보험협회 / '0357'=생명보험협회 등 (조회 대상 기관코드)
//
// 사용자 코드에프 콘솔에서 확인된 활성 보험 API 경로
// "내보험다보여"(신용정보원) 하나로 손보·생보 통합 조회 가능. organization=0002 고정.
// 통합 path(/a/insurer-product)는 별도 organization 매핑이 필요해서 일단 보류.
const CODEF_INSURANCE_PATHS = [
  { path: '/v1/kr/insurance/0001/credit4u/contract-info', organization: '0002' },
];

app.post('/api/codef/request-auth', async (req, res) => {
  try {
    const { name, birthDate, phoneNo, telecom, authType, organization } = req.body;
    if (!name || !birthDate || !phoneNo || !telecom || !authType) {
      return res.status(400).json({ error: '필수 필드 누락' });
    }

    const userKey = getOrCreateUserKey(req);
    const existing = memStore.users.get(userKey);

    const baseBody = {
      loginType: '6',                          // 6 = 간편인증
      loginTypeLevel: '1',
      userName: encryptForCodef(name),
      identity: encryptForCodef(birthDate),
      phoneNo: encryptForCodef(phoneNo),
      telecom: telecom,
      loginIdentity: authType,
      isTwoWay: true,
      ...(existing?.connectedId ? { connectedId: existing.connectedId } : {}),
    };

    // 활성화된 path를 순차 시도
    let result = null;
    let lastPath = null;
    let lastBody = null;
    for (const { path: candidate, organization: org } of CODEF_INSURANCE_PATHS) {
      lastPath = candidate;
      lastBody = { ...baseBody, organization: org };
      console.log(`[CODEF] 인증 요청 시도: ${candidate} (org=${org})`);
      result = await callCodef(candidate, lastBody);
      const code = result.body?.result?.code;
      console.log(`[CODEF] 응답: code=${code} extra=${(result.body?.result?.extraMessage || '').slice(0,120)}`);
      // CF-00003(path 없음) 또는 CF-09002(org 잘못)면 다음 후보. 그 외엔 break.
      if (code !== 'CF-00003' && code !== 'CF-09002') break;
    }
    const path = lastPath;

    if (result.body?.result?.code === 'CF-03002' || result.body?.result?.extraMessage) {
      // 추가 인증 진행 중 (2-Way) - 사용자에게 인증 안내
      const twoWayInfo = result.body.data || {};
      memStore.pendingAuths.set(userKey, {
        path,                              // 어떤 path로 1차 요청했는지 기억
        body: lastBody,                    // 어떤 organization으로 요청했는지 그대로 보관
        jobIndex: twoWayInfo.jobIndex,
        threadIndex: twoWayInfo.threadIndex,
        jti: twoWayInfo.jti,
        twoWayTimestamp: twoWayInfo.twoWayTimestamp,
        startedAt: Date.now(),
      });
      return res.json({
        status: 'PENDING_AUTH',
        message: `${getAuthName(authType)} 앱에서 인증을 완료해 주세요.`,
        userKey,
      });
    }

    // 즉시 응답 받음 (드물지만, 캐시된 connectedId로 바로 조회된 경우)
    if (result.body?.result?.code === 'CF-00000') {
      const cid = result.body?.data?.connectedId;
      if (cid) memStore.users.set(userKey, {
        connectedId: cid,
        insurers: result.body.data,
        createdAt: Date.now(),
        lastQueriedAt: Date.now(),
      });
      return res.json({ status: 'OK', data: result.body.data, userKey });
    }

    return res.status(400).json({ status: 'ERROR', codef: result.body });
  } catch (e) {
    console.error('[request-auth]', e);
    res.status(500).json({ error: e.message });
  }
});

function getAuthName(code) {
  return {'0':'카카오톡','1':'통신사 PASS','2':'삼성패스','3':'KB모바일','4':'페이코','5':'네이버','6':'신한'}[code] || '간편인증';
}

// --------------------------------------------------------
// POST /api/codef/credit4u-register-start — credit4u 회원가입 1차 요청
// --------------------------------------------------------
// 입력: { name, birthDate(YYMMDD), phoneNo, telecom, id, password, email, authMethod }
//   authMethod: '0'=SMS, '1'=PASS
// 출력: { status: 'PENDING_SMS' | 'OK' | 'ERROR', userKey, ... }
//
// CF-03002 + continue2Way: true → SMS 인증번호 필요
// 사용자가 본인 휴대폰에서 SMS 인증번호 받으면 → credit4u-register-continue로 전달
app.post('/api/codef/credit4u-register-start', async (req, res) => {
  try {
    const { name, birthDate, phoneNo, telecom, id, password, email, authMethod } = req.body;
    if (!name || !birthDate || !phoneNo || !telecom || !id || !password || !email) {
      return res.status(400).json({ error: '필수 필드 누락 (이름·생년월일·휴대폰·통신사·ID·비번·이메일 모두 필요)' });
    }
    // ID 형식 검증: 영문+숫자 6~12자, 첫 글자 영문
    if (!/^[a-zA-Z][a-zA-Z0-9]{5,11}$/.test(id)) {
      return res.status(400).json({ error: 'ID는 영문으로 시작하는 영문+숫자 6~12자여야 합니다.' });
    }

    const userKey = getOrCreateUserKey(req);

    const body = {
      organization: '0001',
      userName: name,                              // credit4u는 이름 평문
      identity: encryptForCodef(birthDate),        // 주민번호 뒷자리 또는 생년월일
      birthDate: birthDate,                         // YYMMDD
      identityEncYn: 'Y',
      telecom: telecom,
      phoneNo: encryptForCodef(phoneNo),
      authMethod: authMethod || '0',                // 기본 SMS
      type: '0',                                    // 본인인증 → 가입 한 번에
      id: id,
      password: encryptForCodef(password),
      email: email,
      timeout: '160',
    };

    const path = '/v1/kr/insurance/0001/credit4u/register';
    console.log(`[CODEF] credit4u 가입 1차 요청 (id=${id}, email=${email})`);
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 응답: code=${code} continue2Way=${data.continue2Way} method=${data.method}`);

    if (code === 'CF-03002' && data.continue2Way) {
      // SMS 인증 대기
      memStore.pendingAuths.set(userKey, {
        type: 'credit4u-register',
        body,                              // 1차 요청 body 보존 (continue 시 그대로 + 추가)
        jobIndex: data.jobIndex,
        threadIndex: data.threadIndex,
        jti: data.jti,
        twoWayTimestamp: data.twoWayTimestamp,
        method: data.method,
        startedAt: Date.now(),
      });
      return res.json({
        status: 'PENDING_SMS',
        message: '본인 휴대폰으로 발송된 SMS 인증번호를 입력해주세요.',
        method: data.method,
        userKey,
      });
    }

    if (code === 'CF-00000') {
      // 즉시 가입 완료 (드문 경우)
      return res.json({ status: 'REGISTERED', data: result.body.data, userKey });
    }

    // 다양한 에러
    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[credit4u-register-start]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/codef/credit4u-register-continue — SMS 인증번호 입력
// --------------------------------------------------------
// 입력: { userKey, smsCode }
// 가입 완료 시 자동으로 contract-info 호출 → 보험 가입내역 반환
app.post('/api/codef/credit4u-register-continue', async (req, res) => {
  try {
    const userKey = req.body.userKey || getOrCreateUserKey(req);
    const smsCode = (req.body.smsCode || '').trim();
    if (!smsCode) return res.status(400).json({ error: 'SMS 인증번호 입력 필요' });

    const pending = memStore.pendingAuths.get(userKey);
    if (!pending || pending.type !== 'credit4u-register') {
      return res.status(400).json({ error: '진행 중인 가입이 없습니다. 처음부터 다시 시도해주세요.' });
    }

    const body = {
      ...pending.body,
      is2Way: true,
      jobIndex: pending.jobIndex,
      threadIndex: pending.threadIndex,
      jti: pending.jti,
      twoWayTimestamp: pending.twoWayTimestamp,
      extraInfo: {
        reqSMSAuthNo: smsCode,
      },
    };

    const path = '/v1/kr/insurance/0001/credit4u/register';
    console.log(`[CODEF] credit4u 가입 2차 (SMS) 시도`);
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 응답: code=${code} continue2Way=${data.continue2Way}`);

    // 또 다른 2-Way 단계가 있을 수 있음 (이메일 인증 등)
    if (code === 'CF-03002' && data.continue2Way) {
      memStore.pendingAuths.set(userKey, {
        ...pending,
        body,
        jobIndex: data.jobIndex,
        threadIndex: data.threadIndex,
        jti: data.jti,
        twoWayTimestamp: data.twoWayTimestamp,
        method: data.method,
      });
      return res.json({
        status: 'PENDING_NEXT',
        message: `추가 인증 필요: ${data.method}`,
        method: data.method,
        extraInfo: data.extraInfo,
        userKey,
      });
    }

    if (code === 'CF-00000') {
      memStore.pendingAuths.delete(userKey);
      // 가입 완료 → 즉시 contract-info 호출
      console.log('[CODEF] 가입 완료. contract-info 자동 호출...');
      const loginBody = {
        organization: '0001',
        id: pending.body.id,
        password: pending.body.password,  // 이미 암호화된 상태
        type: '0',
      };
      const queryResult = await callCodef('/v1/kr/insurance/0001/credit4u/contract-info', loginBody);
      const queryCode = queryResult.body?.result?.code;
      console.log(`[CODEF] contract-info 응답: code=${queryCode}`);
      if (queryCode === 'CF-00000') {
        memStore.users.set(userKey, {
          connectedId: queryResult.body?.data?.connectedId,
          insurers: queryResult.body.data,
          createdAt: Date.now(),
          lastQueriedAt: Date.now(),
        });
        return res.json({ status: 'OK', data: queryResult.body.data, userKey });
      }
      return res.json({ status: 'REGISTERED_NEED_LOGIN', message: '가입은 완료. 잠시 후 로그인하여 조회해주세요.', codef: queryResult.body, userKey });
    }

    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[credit4u-register-continue]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/codef/credit4u-status — 가입 여부 확인
// --------------------------------------------------------
app.post('/api/codef/credit4u-status', async (req, res) => {
  try {
    const { name, birthDate, phoneNo, telecom } = req.body;
    if (!name || !birthDate || !phoneNo || !telecom) {
      return res.status(400).json({ error: '이름·생년월일·휴대폰·통신사 필요' });
    }
    const body = {
      organization: '0001',
      userName: name,
      identity: encryptForCodef(birthDate),
      birthDate: birthDate,
      identityEncYn: 'Y',
      telecom: telecom,
      phoneNo: encryptForCodef(phoneNo),
      authMethod: '0',
    };
    const path = '/v1/kr/insurance/0001/credit4u/registration-status';
    console.log(`[CODEF] credit4u 가입여부 확인`);
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    console.log(`[CODEF] 응답: code=${code}`);
    return res.json({ codef: result.body, isRegistered: code === 'CF-00000' && result.body?.data?.commJoinYn === '1' });
  } catch (e) {
    console.error('[credit4u-status]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/codef/credit4u-login — 내보험다보여 ID/비밀번호로 보험 조회
// --------------------------------------------------------
// 입력: { id, password }
//   id: credit4u.or.kr에서 만든 로그인 아이디
//   password: 같은 사이트의 비밀번호 (RSA 암호화 후 전송)
// 출력: 사용자의 모든 보험 가입내역 (손보+생보 통합)
app.post('/api/codef/credit4u-login', async (req, res) => {
  try {
    const { id, password, type } = req.body;
    if (!id || !password) {
      return res.status(400).json({ error: 'ID와 비밀번호가 필요합니다' });
    }
    const userKey = getOrCreateUserKey(req);
    const existing = memStore.users.get(userKey);

    const body = {
      organization: '0001',                  // 신용정보원 고정
      id: id,                                 // 평문
      password: encryptForCodef(password),    // RSA 암호화
      type: type || '0',                      // 0=전체
      ...(existing?.connectedId ? { connectedId: existing.connectedId } : {}),
    };

    const path = '/v1/kr/insurance/0001/credit4u/contract-info';
    console.log(`[CODEF] credit4u 로그인 시도: ${path}`);
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    console.log(`[CODEF] 응답: code=${code} extra=${(result.body?.result?.extraMessage || '').slice(0,120)}`);

    if (code === 'CF-00000') {
      const cid = result.body?.data?.connectedId;
      memStore.users.set(userKey, {
        connectedId: cid,
        insurers: result.body.data,
        createdAt: Date.now(),
        lastQueriedAt: Date.now(),
      });
      return res.json({ status: 'OK', data: result.body.data, userKey });
    }

    // 친절한 에러 메시지
    let hint = '';
    if (code === 'CF-12101') hint = ' — 아이디 또는 비밀번호가 잘못됐습니다.';
    else if (code === 'CF-13301') hint = ' — credit4u.or.kr에 회원이 아닙니다. 먼저 회원가입하세요.';
    else if (code === 'CF-09002') hint = ' — organization 코드 문제. 코드에프 콘솔에서 credit4u API 활성화 여부 확인.';
    return res.status(400).json({ status: 'ERROR', codef: result.body, hint });
  } catch (e) {
    console.error('[credit4u-login]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/codef/complete-auth — 2차: 사용자 인증 완료 후 결과 받기
// --------------------------------------------------------
app.post('/api/codef/complete-auth', async (req, res) => {
  try {
    const userKey = req.body.userKey || getOrCreateUserKey(req);
    const pending = memStore.pendingAuths.get(userKey);
    if (!pending) return res.status(400).json({ error: '진행 중인 인증 없음. 다시 요청해주세요.' });

    const body = {
      ...pending.body,
      jobIndex: pending.jobIndex,
      threadIndex: pending.threadIndex,
      jti: pending.jti,
      twoWayTimestamp: pending.twoWayTimestamp,
      simpleAuth: '1', // 사용자 인증 완료 신호
    };

    const path = pending.path || '/v1/kr/insurance/a/insurer-product/contract-info';
    console.log(`[CODEF] 2차 인증 콜백: ${path}`);
    const result = await callCodef(path, body);
    console.log(`[CODEF] 2차 응답: code=${result.body?.result?.code} extra=${(result.body?.result?.extraMessage || '').slice(0,80)}`);

    if (result.body?.result?.code === 'CF-00000') {
      const cid = result.body?.data?.connectedId;
      memStore.users.set(userKey, {
        connectedId: cid,
        insurers: result.body.data,
        createdAt: Date.now(),
        lastQueriedAt: Date.now(),
      });
      memStore.pendingAuths.delete(userKey);
      return res.json({ status: 'OK', data: result.body.data });
    }

    if (result.body?.result?.extraMessage) {
      // 아직 사용자가 인증 안 한 경우 - 잠시 후 재시도
      return res.json({ status: 'STILL_PENDING', message: '인증 대기 중...' });
    }

    return res.status(400).json({ status: 'ERROR', codef: result.body });
  } catch (e) {
    console.error('[complete-auth]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/analyze-portfolio — 보험 내역 → RAG → Gemini 종합 분석
// --------------------------------------------------------
app.post('/api/analyze-portfolio', async (req, res) => {
  try {
    const userKey = req.body.userKey || getOrCreateUserKey(req);
    const user = memStore.users.get(userKey);
    const insurerList = req.body.portfolio || user?.insurers?.resInsuranceList || [];

    if (insurerList.length === 0) {
      return res.status(400).json({ error: '분석할 보험 내역이 없습니다.' });
    }

    const portfolioSummary = insurerList.map(it => {
      const insurer = it.resCompanyNm || it.resCompany || '?';
      const product = it.resInsuranceNm || it.resProductName || '?';
      const type = it.resInsuranceType || '?';
      const monthly = it.resMonthlyPremium || it.resPremium || '?';
      const note = it.note ? ` / 비고: ${it.note}` : '';
      const year = it.resJoinYear ? ` / ${it.resJoinYear}년 가입` : '';
      return `- ${insurer} ${product} (유형: ${type}, 월 보험료: ${monthly}${year}${note})`;
    }).join('\n');

    const userQuestion = req.body.question || '내가 가입한 보험들의 보장 누락·중복 여부와 개선 방안을 분석해줘';
    console.log(`[analyze-portfolio] ${insurerList.length}건 분석 시작`);

    // 1) 임베딩 (실패 가능) — fallback 빈 배열
    let matches = [];
    try {
      const searchQuery = `${portfolioSummary}\n\n${userQuestion}`;
      const qVec = await embedQuery(searchQuery);
      matches = await searchPinecone(qVec, { topK: 12 });
      console.log(`[analyze-portfolio] RAG: ${matches.length}건 약관 발췌`);
    } catch (embedErr) {
      console.warn('[analyze-portfolio] 임베딩/검색 실패, 일반 지식만으로 답변:', embedErr.message);
    }

    const ragContext = matches.length ? matchesToContext(matches)
      : '(Pinecone에 적재된 약관이 없거나 검색에 실패했습니다. 일반 지식만으로 분석합니다.)';

    const system = `당신은 한국 보험 약관 분석 전문가입니다.
사용자의 실제 가입 보험 내역과 (있다면) RAG로 검색된 약관 발췌를 근거로,
보장 누락, 중복 보장, 보험료 절감 방안을 객관적으로 분석하세요.
- 약관 발췌가 있으면 그 사실만 인용하세요. 추측 금지.
- 약관 발췌가 없으면 일반적인 한국 보험 표준 지식으로 답변하되, 그 사실을 명시하세요.
- 보험사별 차이가 있으면 비교하세요.
- 가능하면 [보험사 - 상품명] 형태로 근거 출처를 나열하세요.
- 특정 상품 가입/해지를 단정적으로 권유하지 마세요. ("검토 권유" 정도까지).`;

    const userPrompt = `[사용자 가입 보험 내역]\n${portfolioSummary}\n\n[관련 약관 발췌]\n${ragContext}\n\n[사용자 추가 질문]\n${userQuestion}\n\n[종합 분석 답변]`;

    // 2) Gemini 호출 (실패 가능)
    let analysis;
    try {
      analysis = await askGemini(system, userPrompt);
    } catch (geminiErr) {
      console.error('[analyze-portfolio] Gemini 실패:', geminiErr.message);
      return res.status(502).json({
        error: 'AI 분석 호출 실패: ' + geminiErr.message,
        hint: 'Gemini API 키 확인 또는 모델 가용성 점검 필요',
      });
    }

    res.json({
      analysis,
      portfolio: insurerList.length,
      sources: matches.map(m => ({
        insurer: m.metadata?.insurer,
        productName: m.metadata?.productName,
        page: m.metadata?.page || m.metadata?.chunkIdx,
        score: m.score,
      })),
      ragAvailable: matches.length > 0,
    });
  } catch (e) {
    console.error('[analyze-portfolio] 예상치 못한 오류:', e);
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5).join('\n') });
  }
});

// --------------------------------------------------------
// POST /api/contact — 전문가 상담 신청 (연락처 수집)
// --------------------------------------------------------
app.post('/api/contact', async (req, res) => {
  try {
    const {
      name, phone, email, message, consent,
      source, auto, chatSummary, report, member,
    } = req.body;
    if (!name || !phone) return res.status(400).json({ error: '이름과 전화번호는 필수' });
    if (!consent) return res.status(400).json({ error: '개인정보 수집 동의 필요' });

    // 진단 레포트 요약 (로그·CRM 가독성용) — 원본 JSON은 report 필드에 그대로 보관
    let reportSummary = null;
    if (report && typeof report === 'object') {
      reportSummary = {
        overallScore: report.overallScore ?? null,
        scoreComment: report.scoreComment || '',
        weakAreas: Array.isArray(report.coverageAnalysis)
          ? report.coverageAnalysis.filter(c => c && (c.level === '부족' || c.level === '보완')).map(c => c.category)
          : [],
        alertCount: Array.isArray(report.alerts) ? report.alerts.length : 0,
      };
    }

    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      // 기본 회원 정보
      name, phone, email, message,
      member: member || null,
      // 신청 경로 (전문가-상담 / 담당설계사-지정 / 채팅-전문가매칭 / 보고서-부족한보장채우기 등)
      source: source || '직접입력',
      auto: !!auto,
      // 채팅 내역 요약
      chatSummary: chatSummary || '',
      // 보험 진단 레포트 (원본 + 요약)
      report: report || null,
      reportSummary,
      createdAt: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    };
    memStore.contacts.push(entry);

    console.log('[CONTACT]', JSON.stringify({
      id: entry.id,
      name: entry.name,
      phone: entry.phone,
      source: entry.source,
      auto: entry.auto,
      hasReport: !!entry.report,
      reportSummary: entry.reportSummary,
      chatSummaryLen: entry.chatSummary.length,
    }));

    // 구글시트 '상담신청' 탭에 저장 (웹훅 미설정 시 자동 skip)
    const sheetResult = await postToSheets({ type: 'contact', ...entry });

    res.json({ status: 'OK', id: entry.id, sheetSaved: !!sheetResult.ok });
  } catch (e) {
    console.error('[contact]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// GET /api/contacts — 접수된 상담/매칭 신청 목록 (운영 확인용)
// ⚠️ 운영 시 반드시 인증 보호 필요 (현재는 POC라 무인증)
// --------------------------------------------------------
app.get('/api/contacts', (req, res) => {
  res.json({ count: memStore.contacts.length, contacts: memStore.contacts });
});

// --------------------------------------------------------
// POST /api/member/signup — 회원 가입/로그인 기록 (카카오 로그인 후 호출 예정)
// 입력: { kakaoId, nickname, email, phone, source }
// 구글시트 '회원' 탭에 저장. (카카오 SDK 연동 시 프론트에서 호출)
// --------------------------------------------------------
if (!memStore.members) memStore.members = new Map();
app.post('/api/member/signup', async (req, res) => {
  try {
    const { kakaoId, nickname, email, phone, source, note } = req.body;
    if (!kakaoId && !phone && !email) {
      return res.status(400).json({ error: '카카오ID·전화·이메일 중 하나는 필요' });
    }
    const key = kakaoId || phone || email;
    const isNew = !memStore.members.has(key);
    const member = {
      kakaoId: kakaoId || '',
      nickname: nickname || '',
      email: email || '',
      phone: phone || '',
      source: source || '카카오',
      note: note || '',
      firstSeenAt: isNew ? new Date().toISOString() : memStore.members.get(key).firstSeenAt,
      lastSeenAt: new Date().toISOString(),
    };
    memStore.members.set(key, member);

    // 신규 회원만 시트에 1줄 기록 (재로그인은 기록 안 함)
    let sheetSaved = false;
    if (isNew) {
      const r = await postToSheets({ type: 'member', ...member });
      sheetSaved = !!r.ok;
    }
    console.log('[MEMBER]', JSON.stringify({ key, isNew, nickname: member.nickname }));
    res.json({ status: 'OK', isNew, sheetSaved });
  } catch (e) {
    console.error('[member/signup]', e);
    res.status(500).json({ error: e.message });
  }
});

// --------------------------------------------------------
// POST /api/auth/kakao — 카카오 로그인 콜백 (code → 토큰 → 사용자정보)
// --------------------------------------------------------
// 프론트에서 Kakao.Auth.authorize 리다이렉트로 받은 code 를 전달하면,
// 백엔드가 REST API 키로 토큰 교환 후 사용자 정보를 조회해 반환 + 회원 저장.
// 입력: { code, redirectUri }
// 출력: { status:'OK', user:{ kakaoId, nickname, email, phone }, isNew }
app.post('/api/auth/kakao', async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    if (!code) return res.status(400).json({ error: 'code 누락' });
    if (!process.env.KAKAO_REST_API_KEY) {
      return res.status(500).json({ error: 'KAKAO_REST_API_KEY 미설정 (.env 확인)' });
    }
    const redirect = redirectUri || process.env.KAKAO_REDIRECT_URI;
    if (!redirect) return res.status(400).json({ error: 'redirectUri 미설정' });

    // 1) code → access_token
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.KAKAO_REST_API_KEY,
      redirect_uri: redirect,
      code,
    });
    if (process.env.KAKAO_CLIENT_SECRET) {
      tokenParams.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
    }
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: tokenParams.toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.warn('[Kakao] 토큰 실패:', JSON.stringify(tokenData).slice(0, 200));
      return res.status(400).json({ error: '카카오 토큰 교환 실패', detail: tokenData });
    }

    // 2) 사용자 정보 조회
    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    const me = await meRes.json();
    const acc = me.kakao_account || {};
    const user = {
      kakaoId: String(me.id || ''),
      nickname: (acc.profile && acc.profile.nickname) || '카카오 회원',
      // 실명: 이름(name) 동의항목 심사 통과 시 내려옴. 없으면 닉네임으로 대체.
      name: acc.name || (acc.profile && acc.profile.nickname) || '',
      email: acc.email || '',
      // 전화번호: 비즈앱 심사 통과 시에만 내려옴. 형식: +82 10-1234-5678 → 010-1234-5678 로 변환
      phone: normalizeKakaoPhone(acc.phone_number || ''),
      // 성별(male/female → 남/여), 출생연도(예: 1990) — 동의항목 심사 통과 시 내려옴
      gender: acc.gender === 'female' ? '여' : acc.gender === 'male' ? '남' : '',
      birthyear: acc.birthyear || '',
    };

    // 3) 회원 저장 (신규만 시트 기록)
    const key = user.kakaoId || user.email;
    const isNew = key ? !memStore.members.has(key) : true;
    if (key) {
      const member = {
        kakaoId: user.kakaoId, nickname: user.nickname, name: user.name, email: user.email, phone: user.phone,
        gender: user.gender, birthyear: user.birthyear,
        source: '카카오로그인', note: '',
        firstSeenAt: isNew ? new Date().toISOString() : memStore.members.get(key).firstSeenAt,
        lastSeenAt: new Date().toISOString(),
      };
      // 액세스 토큰은 메모리에만 보관(회원 탈퇴 시 카카오 연결 끊기에 사용) — 시트엔 안 보냄
      memStore.members.set(key, { ...member, accessToken: tokenData.access_token });
      if (isNew) await postToSheets({ type: 'member', ...member });
    }

    console.log('[Kakao] 로그인 성공:', user.nickname, isNew ? '(신규)' : '(기존)');
    res.json({ status: 'OK', user, isNew });
  } catch (e) {
    console.error('[auth/kakao]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// POST /api/member/unlink — 회원 탈퇴: 카카오 연결 끊기 + 계정 정보 삭제
//   입력: { kakaoId }
//   1) 저장된 사용자 토큰으로 /v1/user/unlink (없거나 실패 시 KAKAO_ADMIN_KEY로 강제 끊기)
//   2) 서버 회원 저장소에서 완전 삭제 → 다음 로그인은 신규로 처리(동의창 다시 뜸)
// ============================================================
app.post('/api/member/unlink', async (req, res) => {
  try {
    const { kakaoId } = req.body || {};
    if (!kakaoId) return res.status(400).json({ error: 'kakaoId 필요' });
    const m = memStore.members.get(String(kakaoId));
    let kakaoUnlinked = false;

    // 1) 사용자 액세스 토큰으로 연결 끊기
    if (m && m.accessToken) {
      try {
        const r = await fetch('https://kapi.kakao.com/v1/user/unlink', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + m.accessToken },
        });
        kakaoUnlinked = r.ok;
        if (!r.ok) console.warn('[unlink] 사용자 토큰 연결끊기 실패', r.status);
      } catch (e) { console.warn('[unlink] 사용자 토큰 오류', e.message); }
    }

    // 2) 실패 시 어드민 키로 강제 연결 끊기(선택: KAKAO_ADMIN_KEY 설정 시)
    if (!kakaoUnlinked && process.env.KAKAO_ADMIN_KEY) {
      try {
        const r = await fetch('https://kapi.kakao.com/v1/user/unlink', {
          method: 'POST',
          headers: {
            'Authorization': 'KakaoAK ' + process.env.KAKAO_ADMIN_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'target_id_type=user_id&target_id=' + encodeURIComponent(kakaoId),
        });
        kakaoUnlinked = r.ok;
        if (!r.ok) console.warn('[unlink] 어드민 연결끊기 실패', r.status);
      } catch (e) { console.warn('[unlink] 어드민 오류', e.message); }
    }

    // 3) 서버 회원 정보 삭제
    const deleted = memStore.members.delete(String(kakaoId));
    console.log('[unlink] 탈퇴 처리', { kakaoId, deleted, kakaoUnlinked });
    res.json({ status: 'OK', deleted, kakaoUnlinked });
  } catch (e) {
    console.error('[member/unlink]', e);
    res.status(500).json({ error: e.message });
  }
});

function normalizeKakaoPhone(p) {
  if (!p) return '';
  // "+82 10-1234-5678" → "010-1234-5678"
  let s = p.replace(/^\+82\s*/, '0').replace(/\s+/g, '');
  return s;
}

// ============================================================
// credit4u 아이디 찾기 (find-id) — SMS 2-way
//   입력: { name, birthDate(YYMMDD), genderDigit(주민번호 7번째 1자리), phoneNo, telecom }
//   → SMS 인증번호 발송 → continue에서 smsCode 입력 → 신용정보원이 아이디를 문자로 발송
//   ⚠️ CODEF 데모/실데이터로만 테스트 가능. 암호화 여부는 테스트로 확정 필요.
// ============================================================
app.post('/api/codef/credit4u-findid-start', async (req, res) => {
  try {
    const { name, birthDate, genderDigit, phoneNo, telecom } = req.body;
    if (!name || !birthDate || !genderDigit || !phoneNo || !telecom) {
      return res.status(400).json({ error: '이름·생년월일·성별자리·휴대폰·통신사 필요' });
    }
    const userKey = getOrCreateUserKey(req);
    const identity7 = (String(birthDate) + String(genderDigit)).slice(0, 7); // 주민번호 앞6 + 성별1

    const body = {
      organization: '0001',
      userName: name,
      identity: identity7,                 // 7자리(앞6+성별1) 평문
      sendMethod: '1',                     // 1: 휴대폰(문자/카톡)로 아이디 발송
      telecom: telecom,
      phoneNo: phoneNo,                    // 문서상 암호화 명시 없음 → 평문
      authMethod: '0',                     // SMS 인증
      timeout: '170',
    };
    const path = '/v1/kr/insurance/0001/credit4u/find-id';
    console.log('[CODEF] 아이디찾기 1차 요청');
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 응답: code=${code} continue2Way=${data.continue2Way} method=${data.method}`);

    if (code === 'CF-03002' && data.continue2Way) {
      memStore.pendingAuths.set(userKey, {
        type: 'findid', body,
        jobIndex: data.jobIndex, threadIndex: data.threadIndex,
        jti: data.jti, twoWayTimestamp: data.twoWayTimestamp, method: data.method,
      });
      return res.json({ status: 'PENDING_SMS', message: '휴대폰으로 발송된 SMS 인증번호를 입력해주세요.', method: data.method, userKey });
    }
    if (code === 'CF-00000') {
      const d = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
      return res.json({ status: 'OK', maskedId: d?.resLoginId || '', registered: d?.resRegistrationStatus === '1', userKey });
    }
    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[findid-start]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/codef/credit4u-findid-continue', async (req, res) => {
  try {
    const userKey = req.body.userKey || getOrCreateUserKey(req);
    const smsCode = (req.body.smsCode || '').trim();
    if (!smsCode) return res.status(400).json({ error: 'SMS 인증번호 입력 필요' });
    const pending = memStore.pendingAuths.get(userKey);
    if (!pending || pending.type !== 'findid') {
      return res.status(400).json({ error: '진행 중인 아이디찾기가 없습니다. 처음부터 다시 시도해주세요.' });
    }
    const body = {
      ...pending.body,
      is2Way: true,
      twoWayInfo: {
        jobIndex: pending.jobIndex, threadIndex: pending.threadIndex,
        jti: pending.jti, twoWayTimestamp: pending.twoWayTimestamp,
      },
      smsAuthNo: smsCode,
      secureNoRefresh: '0',
    };
    const result = await callCodef('/v1/kr/insurance/0001/credit4u/find-id', body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 아이디찾기 2차 응답: code=${code}`);

    if (code === 'CF-03002' && data.continue2Way) {
      memStore.pendingAuths.set(userKey, { ...pending, body, jobIndex: data.jobIndex, threadIndex: data.threadIndex, jti: data.jti, twoWayTimestamp: data.twoWayTimestamp, method: data.method });
      return res.json({ status: 'PENDING_NEXT', message: `추가 인증 필요: ${data.method}`, userKey });
    }
    if (code === 'CF-00000') {
      memStore.pendingAuths.delete(userKey);
      const d = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
      return res.json({ status: 'OK', maskedId: d?.resLoginId || '', registered: d?.resRegistrationStatus === '1', data: d });
    }
    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[findid-continue]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// credit4u 비밀번호 찾기/재설정 (change-pwd) — 다단계 2-way
//   흐름: 1차요청 → (보안문자 자동) → SMS 인증 → 이메일 임시비번 입력 → 새 비번 설정
//   start 입력: { name, birthDate, rrnBack7(주민번호 뒤7자리), id, newPassword, phoneNo, telecom }
//   continue 입력: { userKey, smsCode?, tempPassword?, newPassword? } — 단계별로 필요한 값만
//   응답의 need: 'sms' | 'tempPassword' | 'newPassword' | null(완료)
//   ⚠️ 다단계라 실계정 테스트로 다듬어야 함.
// ============================================================
function pwdNeedFromExtra(extra) {
  if (!extra) return null;
  if (extra.reqSMSAuthNo !== undefined && extra.reqSMSAuthNo !== null && extra.reqSMSAuthNo !== '') return 'sms';
  if (extra.reqUserPass1 !== undefined && extra.reqUserPass1 !== null) return 'tempPassword';
  if (extra.reqUserPass !== undefined && extra.reqUserPass !== null) return 'newPassword';
  if (extra.reqSMSAuthNo !== undefined) return 'sms';
  return null;
}

app.post('/api/codef/credit4u-changepwd-start', async (req, res) => {
  try {
    const { name, birthDate, rrnBack7, id, newPassword, phoneNo, telecom } = req.body;
    if (!name || !birthDate || !rrnBack7 || !id || !phoneNo || !telecom) {
      return res.status(400).json({ error: '이름·생년월일·주민번호뒤7·아이디·휴대폰·통신사 필요' });
    }
    const userKey = getOrCreateUserKey(req);
    const body = {
      organization: '0001',
      userName: name,
      identity: encryptForCodef(rrnBack7),  // 주민번호 뒤 7자리 RSA
      birthDate: birthDate,                  // yymmdd
      identityEncYn: 'Y',
      id: id,
      sendMethod: '1',                       // 1: 휴대폰 발송(문자/카톡 알림톡)으로 임시비번 수신
      telecom: telecom,
      phoneNo: phoneNo,                      // 문서상 암호화 명시 없음 → 평문
      type: '1',                             // 1: 변경할 비번은 추가인증 단계에서 입력
      authMethod: '0',                       // SMS
      timeout: '170',
      // applicationType 미설정 = 보안숫자 자동 인식(아이디찾기와 동일). '1'이면 수동이라 SMS까지 못 감.
    };
    const path = '/v1/kr/insurance/0001/credit4u/change-pwd';
    console.log('[CODEF] 비번찾기 1차 요청');
    const result = await callCodef(path, body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 응답: code=${code} continue2Way=${data.continue2Way} method=${data.method}`);

    if (code === 'CF-03002' && data.continue2Way) {
      memStore.pendingAuths.set(userKey, {
        type: 'changepwd', body, newPassword: newPassword ? encryptForCodef(newPassword) : null,
        jobIndex: data.jobIndex, threadIndex: data.threadIndex, jti: data.jti, twoWayTimestamp: data.twoWayTimestamp, method: data.method,
      });
      const need = pwdNeedFromExtra(data.extraInfo) || 'sms';
      return res.json({ status: 'PENDING', need, message: 'SMS 인증번호를 입력해주세요.', userKey });
    }
    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[changepwd-start]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/codef/credit4u-changepwd-continue', async (req, res) => {
  try {
    const userKey = req.body.userKey || getOrCreateUserKey(req);
    const { smsCode, tempPassword, newPassword } = req.body;
    const pending = memStore.pendingAuths.get(userKey);
    if (!pending || pending.type !== 'changepwd') {
      return res.status(400).json({ error: '진행 중인 비밀번호찾기가 없습니다. 처음부터 다시 시도해주세요.' });
    }
    // 임시비번/새비번은 단계에 걸쳐 유지(2-way가 여러 라운드 필요할 수 있음)
    if (tempPassword) pending.tempPassword = String(tempPassword).trim();
    if (newPassword) pending.newPassword = encryptForCodef(newPassword);

    const body = {
      ...pending.body,
      is2Way: true,
      twoWayInfo: {
        jobIndex: pending.jobIndex, threadIndex: pending.threadIndex,
        jti: pending.jti, twoWayTimestamp: pending.twoWayTimestamp,
      },
      secureNoRefresh: '0',
    };
    if (smsCode) body.smsAuthNo = String(smsCode).trim();
    if (pending.tempPassword) body.password1 = encryptForCodef(pending.tempPassword); // 카톡으로 받은 임시비번
    if (pending.newPassword) body.password = pending.newPassword;                     // 재설정할 새 비번

    const result = await callCodef('/v1/kr/insurance/0001/credit4u/change-pwd', body);
    const code = result.body?.result?.code;
    const data = result.body?.data || {};
    console.log(`[CODEF] 비번찾기 진행 응답: code=${code} continue2Way=${data.continue2Way}`);

    if (code === 'CF-03002' && data.continue2Way) {
      memStore.pendingAuths.set(userKey, { ...pending, body, jobIndex: data.jobIndex, threadIndex: data.threadIndex, jti: data.jti, twoWayTimestamp: data.twoWayTimestamp, method: data.method });
      const need = pwdNeedFromExtra(data.extraInfo);
      return res.json({ status: 'PENDING', need: need || 'sms', message: '다음 단계 인증이 필요합니다.', userKey });
    }
    if (code === 'CF-00000') {
      memStore.pendingAuths.delete(userKey);
      const d = Array.isArray(result.body.data) ? result.body.data[0] : result.body.data;
      const st = d?.resRegistrationStatus;
      return res.json({ status: 'OK', changed: st === '1', tempIssued: st === '2', data: d });
    }
    const rawMsg = (result.body?.result?.message || '').replace(/\+/g, ' ');
    const extra = (result.body?.result?.extraMessage || '').replace(/\+/g, ' ');
    const errMsg = `${rawMsg || extra || '처리 실패'} [${code || '?'}]`;
    return res.status(400).json({ status: 'ERROR', code, message: errMsg, codef: result.body });
  } catch (e) {
    console.error('[changepwd-continue]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// 시작
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 보험 분석 백엔드 실행: http://localhost:${PORT}`);
  console.log(`   Gemini: ${genai ? '✓' : '✗'}, Pinecone: ${pinecone ? '✓' : '✗'}, CODEF: ${process.env.CODEF_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`   Sheets: ${process.env.GOOGLE_SHEETS_WEBHOOK_URL ? '✓' : '✗'}`);
  console.log(`   CORS: ${corsOrigins.join(', ')}`);
});
