# 카카오 로그인 연동 — 발급/설정 체크리스트

카카오 로그인(회원가입)을 실제로 켜려면 아래 값들을 카카오 developers에서 발급·설정한 뒤 알려주시면, 프론트/백엔드 코드에 바로 연결하겠습니다.

> 결정된 방향: **닉네임 + 이메일 + 전화번호**까지 수집.
> 전화번호는 카카오 정책상 **비즈니스 앱 전환 + 동의항목 심사**를 통과해야만 받을 수 있습니다.

---

## A. 지금 바로 발급 가능한 것 (심사 불필요)

카카오 developers(https://developers.kakao.com) → 내 애플리케이션 → 앱 만들기 후:

1. **JavaScript 키** — `앱 설정 → 앱 키 → JavaScript 키`
   → 프론트 `index.html` 의 `KAKAO_JS_KEY` 에 들어갑니다.
2. **REST API 키** — 같은 화면의 `REST API 키`
   → 백엔드 `.env` 의 `KAKAO_REST_API_KEY`.
3. **플랫폼 등록** — `앱 설정 → 플랫폼 → Web 플랫폼 등록`
   - 사이트 도메인: `https://bodoctor-frontend.vercel.app` (+ 로컬 테스트용 `http://localhost:5500` 등)
4. **카카오 로그인 활성화** — `제품 설정 → 카카오 로그인 → 활성화 ON`
5. **Redirect URI 등록** — `카카오 로그인 → Redirect URI`
   - 예: `https://bodoctor-frontend.vercel.app/oauth/kakao` (콜백 받을 주소)
   - 같은 값을 백엔드 `.env` 의 `KAKAO_REDIRECT_URI` 에도 입력.
6. **동의항목 (심사 불필요한 것)** — `카카오 로그인 → 동의항목`
   - 닉네임(profile_nickname): 필수 동의로 설정
   - 카카오계정(이메일)(account_email): 선택 동의로 설정

여기까지면 **닉네임 + 이메일** 로그인은 바로 동작합니다.

## B. 전화번호 수집 (심사 필요)

전화번호 동의항목(`phone_number`)은 기본 잠겨 있습니다.

1. **비즈니스 앱 전환** — `앱 설정 → 비즈니스 → 비즈니스 앱 전환`
   - 사업자등록번호 인증 필요.
2. 전환 후 `동의항목 → 카카오계정(전화번호)` 의 **권한 신청 / 검수** 진행.
   - 사용 목적(보험 상담 연락) 기재 → 카카오 검토 (보통 영업일 며칠).
3. 승인되면 `phone_number` 동의항목을 켤 수 있습니다.

> 심사 전까지는: 카카오로 로그인하되 **전화번호는 첫 로그인 시 한 번 직접 입력**받아 회원으로 저장하는 방식으로 동작하게 만들 수 있습니다(권장 임시안). 심사 통과 후 자동 수집으로 전환하면 됩니다.

## C. (선택) 보안 강화

- `카카오 로그인 → 보안 → Client Secret` 사용 ON → 코드 발급
  → 백엔드 `.env` 의 `KAKAO_CLIENT_SECRET`. (안 켜면 비워둬도 됩니다.)

---

## 나에게 전달해줄 값 (정리)

| 항목 | 위치 | 들어갈 곳 |
|---|---|---|
| JavaScript 키 | 앱 키 | 프론트 `KAKAO_JS_KEY` |
| REST API 키 | 앱 키 | 백엔드 `KAKAO_REST_API_KEY` |
| Redirect URI | 카카오 로그인 설정 | `KAKAO_REDIRECT_URI` |
| Client Secret (선택) | 보안 | `KAKAO_CLIENT_SECRET` |
| 전화번호 동의 승인 여부 | 비즈앱 검수 | 자동수집 vs 1회입력 결정 |

위 값들(또는 A까지만이라도)을 알려주시면 로그인 버튼들을 실제 카카오 인증으로 교체하고, 로그인 성공 시 회원정보를 구글시트 `회원` 탭에 저장하도록 연결하겠습니다.

---

## 현재 코드 상태 (참고)

- 프론트 `markLoggedIn()` / `kakaoSignupAndBook()` / `kakaoLoginBtn` 등은 아직 **시뮬레이션**입니다. (키 받으면 실제 SDK 콜백으로 교체)
- 백엔드 `POST /api/member/signup` 엔드포인트는 **미리 만들어 둠** — 카카오 로그인 성공 후 이 API를 호출하면 구글시트 `회원` 탭에 저장됩니다.
- 카카오 공유(`Kakao.Share`)는 JavaScript 키만 넣으면 바로 동작 (로그인과 별개).
