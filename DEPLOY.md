# 보닥터 배포 가이드 (Vercel + Render)

이 문서는 보닥터를 **Vercel(프론트) + Render(백엔드)** 조합으로 배포하는 단계별 절차입니다.

---

## 0. 사전 준비 (반드시 먼저!)

1. **API 키 전부 재발급** — 채팅·코드에 노출된 키는 즉시 폐기하고 새로 발급
   - Gemini: https://aistudio.google.com/apikey
   - Pinecone: https://app.pinecone.io/organizations → API Keys → Rotate
   - CODEF: https://developer.codef.io → My Page → 개발자 정보 → Client Secret 재발급
2. **GitHub 계정 + 빈 리포 2개 생성**
   - `bodoctor-frontend` (보험AI_v2.html 들어갈 곳)
   - `bodoctor-backend` (보험AI백엔드 폴더 통째로)
3. **도메인 구매(선택)** — Cloudflare Registrar 권장. 도메인 없이 vercel.app·onrender.com 서브도메인으로 먼저 띄워도 됨.

---

## 1. 백엔드 배포 (Render)

### 1-1. GitHub에 백엔드 푸시

`보험AI백엔드` 폴더에서:

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<본인>/bodoctor-backend.git
git push -u origin main
```

> ⚠️ `.gitignore`에 `.env`가 포함되어 있는지 한 번 더 확인. 절대 .env 푸시 금지.

### 1-2. Render에서 Web Service 생성

1. https://render.com 가입(GitHub 로그인)
2. **New +** → **Web Service** → 위에서 만든 `bodoctor-backend` 리포 선택
3. 설정:
   - **Name**: `bodoctor-backend`
   - **Region**: Singapore (한국에서 가장 가까움)
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (트래픽 늘면 Starter $7/월)

### 1-3. 환경변수 등록

Render 대시보드 → 서비스 → **Environment** → **Add Environment Variable** 로 `.env.example`의 키들을 그대로 등록:

| Key | Value 예시 |
|---|---|
| `GEMINI_API_KEY` | 새로 발급한 키 |
| `GEMINI_CHAT_MODEL` | `gemini-flash-latest` |
| `PINECONE_API_KEY` | (RAG 사용 시) 새 키 |
| `PINECONE_INDEX` | (RAG 사용 시) 인덱스명 |
| `PINECONE_HOST` | (RAG 사용 시) 호스트 |
| `CODEF_CLIENT_ID` | 새 ID |
| `CODEF_CLIENT_SECRET` | 새 Secret |
| `CODEF_PUBLIC_KEY` | RSA 공개키 |
| `CODEF_HOST` | `https://development.codef.io` (운영 전환 후 `https://api.codef.io`) |
| `CODEF_OAUTH_HOST` | `https://oauth.codef.io` |
| `CORS_ORIGIN` | `https://bodoctor.com,https://www.bodoctor.com` |
| `CORS_ORIGIN_REGEX` | `^https:\/\/bodoctor-[a-z0-9-]+\.vercel\.app$` |

> `PORT`는 Render가 자동 주입하므로 수동 설정 불필요.

### 1-4. 배포 후 URL 확인

배포 완료 시 `https://bodoctor-backend.onrender.com` 같은 URL이 발급됩니다.
브라우저에서 `/api/health` 접속해 OK 응답이 오는지 확인:

```
https://bodoctor-backend.onrender.com/api/health
```

---

## 2. 프론트엔드 배포 (Vercel)

### 2-1. 프론트 폴더 준비

`보험AI_v2.html`을 단독 폴더(예: `bodoctor-frontend/`)에 넣고 파일명을 **`index.html`** 로 변경.

### 2-2. 백엔드 URL 업데이트

`index.html` 1395줄 근처의 백엔드 URL을 Render 배포 URL로 교체:

```js
// 변경 전
return 'https://bodoctor-backend.onrender.com';

// 변경 후 (실제 발급된 URL)
return 'https://bodoctor-backend-xxxx.onrender.com';
```

### 2-3. GitHub 푸시

```bash
cd bodoctor-frontend
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<본인>/bodoctor-frontend.git
git push -u origin main
```

### 2-4. Vercel에서 Import

1. https://vercel.com 가입(GitHub 로그인)
2. **Add New** → **Project** → `bodoctor-frontend` 리포 선택
3. Framework Preset: **Other** (정적 HTML)
4. Root Directory: `.`
5. **Deploy** 클릭

배포 완료 시 `https://bodoctor-frontend.vercel.app` 같은 URL 발급.

---

## 3. 도메인 연결

### 3-1. Vercel → 프론트 도메인 연결

1. Vercel 프로젝트 → **Settings** → **Domains** → `bodoctor.com` 추가
2. 도메인 등록처(Cloudflare 등)에서 DNS 레코드 추가:
   - `A` 또는 `CNAME` (Vercel이 안내해주는 값으로)

### 3-2. Render → 백엔드 서브도메인 연결 (선택)

1. Render 서비스 → **Settings** → **Custom Domain** → `api.bodoctor.com` 추가
2. DNS에 `CNAME api → bodoctor-backend.onrender.com` 추가
3. `index.html`의 BACKEND URL을 `https://api.bodoctor.com` 으로 교체

---

## 4. 카카오 로그인 설정 (도메인 확정 후)

1. https://developers.kakao.com → 내 애플리케이션 → 보닥터
2. **앱 설정 → 플랫폼**: Web 플랫폼에 `https://bodoctor.com` 등록
3. **카카오 로그인 → Redirect URI**: `https://bodoctor.com/auth/kakao/callback`
4. **동의항목**: 닉네임·이메일·전화번호 등 필요 항목 추가 신청

---

## 5. 운영 체크리스트

- [ ] 모든 API 키 재발급 완료
- [ ] `.env` 깃 제외 확인
- [ ] `/api/health` 정상 응답
- [ ] 프론트 → 백엔드 호출 시 CORS 통과
- [ ] 카카오 로그인 콜백 URL 정확히 매칭
- [ ] 개인정보처리방침 / 이용약관 페이지 추가 (보험·신용정보 서비스 필수)
- [ ] CODEF 운영 전환 — 운영 API는 본승인 + 상품 사용 신청 별도 필요
- [ ] HTTPS 강제 (Vercel·Render 모두 기본 적용)
- [ ] Render 무료 플랜은 15분 idle 시 sleep → 첫 요청 1~2초 지연. 트래픽 늘면 Starter($7/월)로 업그레이드

---

## 6. 자주 묻는 문제

**Q. Render 배포 후 첫 요청이 느려요**
→ 무료 플랜은 슬립 모드 있음. 유료 Starter($7/월)로 업그레이드하거나, cron-job.org로 5분마다 `/api/health` 핑.

**Q. CORS 에러가 나요**
→ 백엔드 환경변수 `CORS_ORIGIN`에 정확한 origin(`https://` 포함, 끝 슬래시 없이) 추가. Vercel 프리뷰 URL은 `CORS_ORIGIN_REGEX`에 정규식으로.

**Q. CODEF가 운영에서 안 돼요**
→ `CODEF_HOST`를 `https://api.codef.io`로 바꾸고, 운영 클라이언트 ID/Secret 재발급 + 사용하려는 상품(credit4u 등) 운영 신청.

**Q. Gemini가 자주 503을 내요**
→ 백엔드에 이미 자동 재시도 + fallback 모델 적용됨. 그래도 부족하면 Gemini Pro 등 유료 모델로 전환하거나 OpenAI/Claude 대안 도입.
