/**
 * 보닥터 — 구글시트 저장 웹훅 (Google Apps Script)
 * ------------------------------------------------------------
 * 사용법은 같은 폴더의 GOOGLE_SHEETS_SETUP.md 참고.
 *
 * 요약:
 *  1) 구글시트 새로 만들기 → 확장 프로그램 → Apps Script
 *  2) 이 파일 내용을 통째로 붙여넣기
 *  3) 아래 SECRET 값을 직접 만든 임의의 문자열로 교체 (백엔드 .env 와 동일하게)
 *  4) 배포 → 새 배포 → 유형: 웹 앱 → 액세스: '모든 사용자' → 배포
 *  5) 나온 웹 앱 URL 을 백엔드 .env 의 GOOGLE_SHEETS_WEBHOOK_URL 에 입력
 *
 * 백엔드가 보내는 JSON 예:
 *  { secret, type: 'contact' | 'member', ...필드 }
 * type 에 따라 '상담신청' / '회원' 시트 탭에 한 줄씩 추가됩니다.
 */

// ⚠️ 백엔드 .env 의 SHEETS_WEBHOOK_SECRET 과 똑같은 값으로 바꾸세요.
var SECRET = 'CHANGE_ME_TO_A_RANDOM_SECRET';

// 각 시트(탭)의 헤더 정의
var HEADERS = {
  '상담신청': [
    '접수시각', '신청ID', '신청경로', '자동접수', '이름', '전화', '카카오ID', '회원여부',
    '상담메시지', '진단점수', '점수코멘트', '부족/보완영역', '확인필요건수', '채팅요약', '레포트원본(JSON)',
    '성별', '출생연도'
  ],
  '회원': [
    '가입시각', '카카오ID', '이름', '닉네임', '이메일', '전화', '성별', '출생연도', '가입경로', '비고'
  ]
};

function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    }

    // 시크릿 검증
    if (SECRET && SECRET !== 'CHANGE_ME_TO_A_RANDOM_SECRET') {
      if (data.secret !== SECRET) {
        return json_({ ok: false, error: 'invalid secret' });
      }
    }

    var type = data.type || 'contact';
    var row;
    var sheetName;

    if (type === 'member') {
      sheetName = '회원';
      row = [
        new Date(),
        data.kakaoId || '',
        data.name || '',
        data.nickname || '',
        data.email || '',
        data.phone || '',
        data.gender || '',
        data.birthyear || '',
        data.source || '카카오',
        data.note || ''
      ];
    } else {
      // contact (상담/매칭 신청)
      sheetName = '상담신청';
      var member = data.member || {};
      var rs = data.reportSummary || {};
      row = [
        new Date(),
        data.id || '',
        data.source || '',
        data.auto ? 'Y' : 'N',
        data.name || '',
        data.phone || '',
        (member && member.kakaoId) || data.kakaoId || '',
        (member && member.isLoggedIn) ? '회원' : '비회원',
        data.message || '',
        (rs.overallScore != null ? rs.overallScore : ''),
        rs.scoreComment || '',
        (rs.weakAreas && rs.weakAreas.length) ? rs.weakAreas.join(', ') : '',
        (rs.alertCount != null ? rs.alertCount : ''),
        data.chatSummary || '',
        data.report ? JSON.stringify(data.report) : '',
        (member && member.gender) || '',
        (member && member.birthyear) || ''
      ];
    }

    var sheet = getOrCreateSheet_(sheetName);
    sheet.appendRow(row);

    return json_({ ok: true, type: type, sheet: sheetName });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// 헬스체크용 (브라우저로 URL 열면 동작 확인)
function doGet() {
  return json_({ ok: true, service: 'bodoctor-sheets-webhook' });
}

function getOrCreateSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  // 헤더 보장: 비어있으면 추가, 이미 있으면 최신 헤더로 동기화(새 컬럼 라벨 자동 반영)
  if (HEADERS[name]) {
    var hdr = HEADERS[name];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(hdr);
    } else {
      sheet.getRange(1, 1, 1, hdr.length).setValues([hdr]);
    }
    sheet.getRange(1, 1, 1, hdr.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
