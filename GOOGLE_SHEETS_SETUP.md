# 구글시트 회원/상담 저장 설정 (Apps Script 웹훅)

상담·매칭 신청과 회원 정보를 구글시트에 자동으로 쌓는 방법입니다. 서비스 계정이나 JSON 키 없이, **시트 + Apps Script만으로** 동작합니다.

소요 시간: 약 5분.

---

## 1단계 — 구글시트 만들기

1. https://sheets.google.com 에서 새 시트를 하나 만듭니다.
2. 시트 이름은 자유 (예: `보닥터 회원DB`).
3. 탭(시트)은 따로 안 만들어도 됩니다. 웹훅이 처음 호출될 때 `상담신청`, `회원` 탭과 헤더를 자동 생성합니다.

## 2단계 — Apps Script 붙여넣기

1. 시트 상단 메뉴 **확장 프로그램 → Apps Script** 클릭.
2. 기본 `Code.gs` 내용을 전부 지우고, 같은 폴더의 **`google-apps-script.gs`** 파일 내용을 통째로 붙여넣습니다.
3. 맨 위 줄을 직접 만든 임의 문자열로 교체:

   ```js
   var SECRET = 'CHANGE_ME_TO_A_RANDOM_SECRET';
   ```
   → 예: `var SECRET = 'bodoctor-7f3a91c2e8';`
   이 값은 백엔드 `.env` 의 `SHEETS_WEBHOOK_SECRET` 과 **똑같이** 맞춰야 합니다.
4. 💾 저장 (Ctrl+S).

## 3단계 — 웹 앱으로 배포

1. 우측 상단 **배포 → 새 배포** 클릭.
2. 톱니바퀴(유형 선택) → **웹 앱**.
3. 설정:
   - 설명: 아무거나 (예: bodoctor webhook)
   - **다음 사용자로 실행: 나(본인 계정)**
   - **액세스 권한이 있는 사용자: 모든 사용자**  ← 중요. 백엔드가 호출하려면 공개여야 함.
4. **배포** 클릭 → 권한 승인 팝업이 뜨면 본인 구글 계정으로 허용 (처음 1회).
   - "Google에서 확인하지 않은 앱" 경고가 나오면 → **고급 → (안전하지 않음) 이동** → 허용. 본인이 만든 스크립트라 안전합니다.
5. 배포 완료 후 나오는 **웹 앱 URL** 을 복사합니다.
   형태: `https://script.google.com/macros/s/AKfycb..../exec`

## 4단계 — 백엔드 환경변수 입력

`보험AI백엔드/.env` 파일에 추가 (없으면 새로 작성):

```
GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/AKfycb..../exec
SHEETS_WEBHOOK_SECRET=bodoctor-7f3a91c2e8
```

운영(Render)에도 동일하게 등록:
**Render 대시보드 → bodoctor-backend → Environment → Add → 위 두 개 추가 → Save → 자동 재배포.**

## 5단계 — 동작 확인

1. 웹 앱 URL 을 브라우저에서 그냥 열어보면 `{"ok":true,"service":"bodoctor-sheets-webhook"}` 가 나와야 정상.
2. 로컬 백엔드로 테스트:
   ```bash
   curl -X POST http://localhost:8787/api/contact \
     -H "Content-Type: application/json" \
     -d '{"name":"테스트","phone":"010-1234-5678","consent":true,"source":"테스트","message":"동작확인"}'
   ```
   → 응답에 `"sheetSaved": true` 가 보이고, 구글시트 `상담신청` 탭에 한 줄이 추가되면 성공.

---

## 저장되는 항목

### `상담신청` 탭 (전문가 매칭/상담/청구 버튼 클릭 시)
접수시각 · 신청ID · 신청경로 · 자동접수 · 이름 · 전화 · 카카오ID · 회원여부 · 상담메시지 · **진단점수 · 점수코멘트 · 부족영역 · 확인필요건수** · **채팅요약** · **레포트원본(JSON)**

→ 요청하신 "기본 회원정보 + 채팅내역 요약 + 보험 진단 레포트"가 모두 한 줄에 들어갑니다.

### `회원` 탭 (카카오 로그인 연동 후 신규 가입 시)
가입시각 · 카카오ID · 닉네임 · 이메일 · 전화 · 가입경로 · 비고

---

## 자주 묻는 문제

- **`sheetSaved: false`** 인데 에러는 없음 → `GOOGLE_SHEETS_WEBHOOK_URL` 미입력 상태. 서비스는 정상 동작하고 시트 저장만 skip 됩니다.
- **`invalid secret`** → `.env` 의 `SHEETS_WEBHOOK_SECRET` 과 Apps Script 의 `SECRET` 값이 다릅니다. 똑같이 맞추세요.
- **코드 수정 후 반영이 안 됨** → Apps Script는 **배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포** 를 해야 새 코드가 적용됩니다. (URL은 그대로 유지됩니다.)
