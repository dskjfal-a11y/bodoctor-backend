# 보험 분석 AI — 백엔드·파이프라인

생명보험협회·손해보험협회 약관을 RAG로 색인하고, 사용자의 실제 가입 보험 내역(코드에프 마이데이터)을 받아 Gemini로 분석해주는 시스템의 백엔드와 데이터 파이프라인입니다.

---

## 폴더 구조

```
보험AI백엔드/
├── README.md                       # 이 파일
├── package.json                    # Node.js 의존성
├── .env.example                    # 환경변수 템플릿 (실제 키는 .env에)
├── 01_crawl_disclosures.js         # 1단계: 약관 PDF 일괄 크롤링·다운로드
├── 02_parse_chunk_embed.js         # 2~5단계: 파싱·청크·임베딩·Pinecone
├── 03_backend_server.js            # 6단계: Express 백엔드
└── data/                           # 다운로드된 PDF·텍스트 (스크립트가 생성)
    ├── pdfs/
    └── chunks/
```

`insurance-ai-gemini.html` 수정본은 같은 바탕화면에 별도 저장됩니다.

---

## ⚠️ 보안 — 가장 먼저 읽으세요

1. **이 채팅에 평문으로 공유된 모든 API 키는 즉시 폐기/재발급하세요.**
   - Gemini: <https://aistudio.google.com/app/apikey>
   - Pinecone: <https://app.pinecone.io> → API Keys
   - 코드에프: <https://codef.io> 콘솔
   대화 로그는 영구히 보존되므로 그대로 두면 누구든 무단 사용할 수 있습니다.
2. **새 키는 절대 코드에 하드코딩하지 말고 `.env` 파일에만 두세요.** `.env`는 `.gitignore`에 포함하고 절대 깃에 올리지 마세요.
3. 운영 배포 시에는 키를 GitHub Secrets·AWS Secrets Manager·HashiCorp Vault 같은 비밀 관리 서비스로 옮기세요.

---

## ⚠️ 본인인증 자동화 금지 — 설계 원칙

요청에 있던 "카카오/PASS 간편인증을 백엔드가 자동으로 처리"는 **구현하지 않았습니다**. 이유:

- 카카오·PASS(통신3사)·NICE·KCB 등 모든 본인확인기관의 이용약관이 자동화·우회를 명시적으로 금지합니다.
- 자동화 시 보이스피싱·명의도용 도구로 악용될 수 있어 정보통신망법·전자금융거래법 위반 + 형사처벌 대상이 됩니다.
- 코드에프 자체가 "사용자가 직접 인증 → 코드에프가 그 결과를 안전하게 토큰화" 흐름을 표준으로 합니다.

따라서 백엔드는 **인증을 직접 수행하지 않고**, 코드에프가 제공하는 표준 흐름인 *간편인증 요청 → 사용자 인증 → 두 번째 호출(2-Way)*만 처리합니다. 사용자는 자신의 휴대폰에서 카카오/PASS 앱을 직접 열어 인증해야 합니다.

---

## ⚠️ 법적 요건 — 실서비스 운영 전 반드시 확인

이 코드를 실서비스로 운영하려면 다음을 별도로 갖춰야 합니다.

| 요건 | 근거 | 비고 |
|---|---|---|
| 보험중개업 또는 보험비교·추천 서비스 등록 | 보험업법 | 금융위원회 |
| 본인신용정보관리업(마이데이터) 본 허가 | 신용정보법 | 코드에프 자체는 본 허가 보유, 재판매 시 별도 검토 필요 |
| 개인정보보호 및 신용정보 처리 위탁 약정 | 개보법·신용정보법 | 코드에프와 위수탁 계약 |
| ISMS 또는 ISMS-P 인증 | 정보통신망법·개보법 | 정보보호 관리체계 |
| 약관·개인정보처리방침 게시 | 개보법·약관규제법 | 동의 분리 필수 |
| 광고규제 검토 | 보험업법·표시광고법 | "최저가"·"100%" 등 과장표현 금지 |

이 코드는 **POC·내부 테스트용**입니다. 위 요건이 갖춰지지 않은 상태로 일반 사용자에게 서비스하지 마세요.

---

## 사전 준비

```bash
# Node.js 20+ 필요
node --version

# 의존성 설치
cd 보험AI백엔드
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 열어 실제 키 입력
```

`.env` 파일에 필요한 값:
- `GEMINI_API_KEY` — Google AI Studio에서 새로 발급
- `PINECONE_API_KEY` — Pinecone Console에서 새로 발급
- `PINECONE_INDEX` — Pinecone 인덱스 이름 (예: `insurance-clauses`)
- `PINECONE_HOST` — Pinecone 인덱스 호스트 (예: `https://insurance-clauses-xxxx.svc.us-east1.pinecone.io`)
- `CODEF_CLIENT_ID` — 코드에프 클라이언트 ID
- `CODEF_CLIENT_SECRET` — 코드에프 클라이언트 시크릿
- `CODEF_PUBLIC_KEY` — 코드에프에서 발급한 RSA 공개키 (요청 암호화용)
- `CODEF_HOST` — `https://development.codef.io` (개발) 또는 `https://api.codef.io` (운영)
- `PORT` — 백엔드 포트 (기본 8787)

---

## 사용 순서

### 1단계: 약관 크롤링·다운로드 (시간 매우 오래 걸림)

```bash
node 01_crawl_disclosures.js --max=50          # 처음엔 50개로 테스트
node 01_crawl_disclosures.js --max=all         # 본격 수집 (며칠 단위)
```

생성 위치: `data/pdfs/{협회}/{보험사}/{상품코드}.pdf` + `data/pdfs/manifest.jsonl` (메타데이터)

> 손해보험협회(KNIA)와 생명보험협회(KLIA)는 사이트 구조가 달라 각각 다른 셀렉터로 크롤링합니다. 사이트 개편 시 셀렉터를 업데이트해야 합니다.

### 2~5단계: 파싱·청크·임베딩·Pinecone

```bash
# 처음 한 번: Pinecone 인덱스 생성 (3072차원, gemini-embedding-001 기준)
node 02_parse_chunk_embed.js --create-index

# PDF → 청크 → 임베딩 → upsert
node 02_parse_chunk_embed.js --run
```

청크 메타데이터: `{ insurer, productName, generation, sourceUrl, pdfFile, page, chunkIdx }`

### 6단계: 백엔드 서버 실행

```bash
node 03_backend_server.js
# → http://localhost:8787
```

엔드포인트:
- `POST /api/ask` — 질문 → RAG → Gemini 답변
- `POST /api/codef/request-auth` — 코드에프 간편인증 요청(1차)
- `POST /api/codef/complete-auth` — 사용자가 카카오/PASS 인증 완료 후 결과 콜백(2차)
- `POST /api/analyze-portfolio` — 조회된 보험 내역 → RAG로 약관 검색 → Gemini 분석
- `POST /api/contact` — 전문가 상담 신청 (연락처 수집)

### 7단계: 프론트엔드

수정된 `insurance-ai-gemini.html`을 브라우저로 열면 백엔드(`http://localhost:8787`)를 호출합니다. 도메인이 다르면 백엔드 `CORS_ORIGIN` 환경변수에 프론트 도메인을 추가하세요.

---

## 개발자 메모

- **약관 다운로드 양**: 생보 22사 + 손보 13사 × 평균 100개 상품 ≈ 3,500개 PDF. 평균 5MB로 잡으면 약 17GB.
- **임베딩 비용**: `gemini-embedding-001`은 입력 토큰 기준 과금. 3,500개 약관 × 평균 200페이지 × 약 300토큰/페이지 ≈ 2.1억 토큰. 가격은 [Gemini 가격표](https://ai.google.dev/pricing)에서 직접 확인하세요.
- **Pinecone 비용**: 3,072차원 × 수십만 청크 → 서버리스 인덱스 기준 수십 GB. 월 수십~수백 달러.

이 코드는 **샘플 50~100개**로 먼저 검증한 뒤 단계적으로 확장하세요.
