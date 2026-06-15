/**
 * 01_crawl_disclosures.js
 * ------------------------------------------------------------
 * 1단계: 생명보험협회(KLIA)·손해보험협회(KNIA) 공시실에서
 *        전체 보험 상품 약관 PDF 목록을 크롤링하고 다운로드합니다.
 *
 * 사용:
 *   node 01_crawl_disclosures.js --max=50      # 50개만 (테스트)
 *   node 01_crawl_disclosures.js --max=all     # 전체 (수 시간~수일)
 *   node 01_crawl_disclosures.js --source=knia # 손보만
 *   node 01_crawl_disclosures.js --source=klia # 생보만
 *
 * 산출:
 *   data/pdfs/{협회}/{보험사}/{slug}.pdf
 *   data/pdfs/manifest.jsonl   (각 줄: {insurer, productName, sourceUrl, pdfFile, ...})
 *
 * ⚠️ 사이트 개편 시 셀렉터·URL이 바뀝니다. 크롤링 전 robots.txt 및
 *    이용약관을 확인하고 협회와 사전 협의를 권장합니다.
 *    상업적 사용은 협회 정책에 따라 제한될 수 있습니다.
 */

import { writeFileSync, existsSync, mkdirSync, createWriteStream, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import pLimit from 'p-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data', 'pdfs');
const MANIFEST = join(DATA_DIR, 'manifest.jsonl');

// ---------- CLI ----------
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);
const MAX = args.max === 'all' ? Infinity : (parseInt(args.max, 10) || 50);
const ONLY = args.source; // 'klia' | 'knia' | undefined
const CONCURRENCY = parseInt(args.concurrency, 10) || 4;

mkdirSync(DATA_DIR, { recursive: true });

// ---------- 공통 유틸 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => s.replace(/[^\w가-힣]+/g, '_').slice(0, 80);

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'InsuranceAI-RAG-POC/0.1 (+contact: your@email.com)',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      ...opts.headers,
    },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function downloadPdf(url, outPath) {
  if (existsSync(outPath)) return { skipped: true };
  mkdirSync(dirname(outPath), { recursive: true });
  const res = await fetch(url, {
    headers: { 'User-Agent': 'InsuranceAI-RAG-POC/0.1' },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await pipeline(res.body, createWriteStream(outPath));
  return { skipped: false, bytes: parseInt(res.headers.get('content-length') || '0', 10) };
}

function appendManifest(entry) {
  appendFileSync(MANIFEST, JSON.stringify(entry) + '\n', 'utf8');
}

// ============================================================
// KNIA (손해보험협회) — kpub.knia.or.kr
// ============================================================
// KNIA는 회사별 약관 PDF를 직접 호스팅하지 않으므로, 각 보험사 공시
// 사이트(예: samsungfire.com, hi.co.kr 등)로 이동해 약관을 찾아야 합니다.
// 여기서는 협회 비교공시 페이지의 상품 목록을 가져와 보험사 페이지
// 링크를 수집하고, 각 보험사별 어댑터로 PDF를 가져옵니다.
//
// 본 POC에서는 손보 13개사 중 주요 9개사에 대해 사전 수집한 약관 PDF
// 직링크 매핑 테이블을 사용합니다. (실서비스에선 보험사별 약관
// 다운로드 페이지를 매월 크롤링하는 별도 잡 필요)

const KNIA_DIRECT_LINKS = [
  { insurer: '삼성화재', productName: '무배당 삼성화재 다이렉트 실손의료비보험(2605.1)',
    url: 'https://direct.samsungfire.com/docs/realloss.pdf', generation: '5세대' },
  { insurer: '현대해상', productName: '무배당 현대해상다이렉트 실손의료비보장보험(갱신형)(Hi2601)',
    url: 'https://mdirect.hi.co.kr/dhNAS/terms/CM12M1_20260101.pdf', generation: '5세대' },
  { insurer: 'DB손해보험', productName: '무배당 프로미라이프 다이렉트 실손의료비보험2301(CM)',
    url: 'https://m.directdb.co.kr/doc/pdf/terms/ltm_direct_medical2301.pdf', generation: '4세대' },
  { insurer: 'KB손해보험', productName: 'KB손보 실손의료비보장보험(무배당)(25.04)',
    url: 'http://www.cyberinsu.co.kr/Filedata/011/2018042516825013_agree.pdf', generation: '5세대' },
  { insurer: '메리츠화재', productName: '무배당 메리츠 실손의료비보험2302',
    url: 'https://cancerok.com/files/bohum/1675902549.pdf', generation: '4세대' },
  { insurer: '한화손해보험', productName: '한화실손 의료보험2301',
    url: 'https://m.hwgeneralins.com/upload/product/medical(2301)_03.pdf', generation: '4세대' },
  { insurer: '흥국화재', productName: '무배당 흥국화재 실손의료보험(25.04)',
    url: 'https://cancerok.com/files/bohum/20250428_26680061590b4c466e9f0e234493d6df.pdf', generation: '5세대' },
  { insurer: '롯데손해보험', productName: '무배당 let:care 실손의료보험Ⅳ(2209)',
    url: 'https://www.lotteins.co.kr/upload/C/let_care_sil_2209_2_yak.pdf', generation: '4세대' },
  { insurer: 'AXA손해보험', productName: '무배당 실손의료보험(중지후재개용)(갱신형)2107',
    url: 'https://www.axa.co.kr/AsianPlatformInternet/doc/internet/public/MERI(only_for_conversion)_provision2107(B).pdf', generation: '4세대' },
];

// 손보 비교공시 페이지에서 추가 상품을 수집하는 어댑터 (실제 셀렉터는 사이트 개편 시 업데이트 필요)
async function crawlKniaCompare(limit) {
  // KNIA의 장기보장성/암/종합 등 카테고리별 공시 페이지에서 PDF 링크 추출
  const categories = [
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/cancerInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/sicknessInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/accidentEtcInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/juvenileInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/teethInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/fireInsurance.do',
    'https://kpub.knia.or.kr/productDisc/longTermGuarantee/comprehensiveInsurance.do',
  ];
  const collected = [];
  for (const url of categories) {
    try {
      const html = await fetchText(url);
      const $ = load(html);
      // 비교공시 페이지 안에 상품명과 약관 PDF 직링크가 함께 있을 경우만 추출
      $('a[href$=".pdf"]').each((_, el) => {
        const href = $(el).attr('href');
        const name = $(el).text().trim() || $(el).attr('title') || 'unknown';
        if (href) collected.push({
          insurer: 'KNIA-수집',
          productName: name,
          url: new URL(href, url).toString(),
          generation: '미상',
        });
      });
      await sleep(800);
    } catch (e) {
      console.warn(`[KNIA] ${url} 실패:`, e.message);
    }
    if (collected.length >= limit) break;
  }
  return collected;
}

// ============================================================
// KLIA (생명보험협회) — pub.insure.or.kr
// ============================================================
// 생보협회는 약관 PDF가 회사별 페이지로 깊이 들어가는 구조입니다.
// 보험사 목록을 가져와 각 사이트에서 약관 페이지로 이동하는 다단계 크롤링이 필요합니다.
// 본 POC에선 생보 22개사 약관 다운로드 페이지 URL만 메모하고,
// 실제 PDF 직링크 수집은 보험사별 어댑터로 단계별로 구현합니다.

const KLIA_INSURER_PAGES = [
  { insurer: '삼성생명', listUrl: 'https://www.samsunglife.com/individual/customer/clause' },
  { insurer: '한화생명', listUrl: 'https://www.hanwhalife.com/static/customer/CT_PUB.jsp' },
  { insurer: '교보생명', listUrl: 'https://www.kyobo.co.kr/customer/clause/searchClause.do' },
  { insurer: 'NH농협생명', listUrl: 'https://www.nhlife.co.kr/customer/clause.do' },
  { insurer: '신한라이프', listUrl: 'https://www.shinhanlife.co.kr/customer/clause' },
  { insurer: '미래에셋생명', listUrl: 'https://www.miraeassetlife.com/info/clause' },
  { insurer: 'KB라이프', listUrl: 'https://www.kbli.co.kr/customer/clause' },
  { insurer: '동양생명', listUrl: 'https://www.myangel.co.kr/customer/clause' },
  { insurer: '흥국생명', listUrl: 'https://www.heungkuklife.co.kr/customer/clause' },
  { insurer: 'IBK연금보험', listUrl: 'https://www.ibki.co.kr/customer/clause' },
  // ... (총 22개사. 사이트 구조 변경 시 직접 업데이트 필요)
];

async function crawlKliaInsurer({ insurer, listUrl }) {
  try {
    const html = await fetchText(listUrl);
    const $ = load(html);
    const pdfs = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\.pdf(\?|$)/i.test(href)) {
        pdfs.push({
          insurer,
          productName: $(el).text().trim() || $(el).attr('title') || 'unknown',
          url: new URL(href, listUrl).toString(),
          generation: '미상',
        });
      }
    });
    return pdfs;
  } catch (e) {
    console.warn(`[KLIA] ${insurer} 실패:`, e.message);
    return [];
  }
}

// ============================================================
// 메인 실행
// ============================================================
async function main() {
  console.log('=== 보험약관 크롤링 시작 ===');
  console.log(`최대 ${MAX === Infinity ? '전체' : MAX}개, 동시성 ${CONCURRENCY}`);

  // 1) 수집 대상 정리
  let targets = [];

  if (!ONLY || ONLY === 'knia') {
    targets.push(...KNIA_DIRECT_LINKS);
    if (MAX > KNIA_DIRECT_LINKS.length) {
      console.log('[KNIA] 카테고리별 추가 수집...');
      const more = await crawlKniaCompare(MAX - KNIA_DIRECT_LINKS.length);
      targets.push(...more);
    }
  }

  if (!ONLY || ONLY === 'klia') {
    for (const ins of KLIA_INSURER_PAGES) {
      if (targets.length >= MAX) break;
      console.log(`[KLIA] ${ins.insurer} 약관 목록 가져오기...`);
      const found = await crawlKliaInsurer(ins);
      targets.push(...found);
      await sleep(500);
    }
  }

  targets = targets.slice(0, MAX);
  console.log(`총 ${targets.length}개 대상 PDF 다운로드`);

  // 2) 다운로드
  const limit = pLimit(CONCURRENCY);
  let okCount = 0, skipCount = 0, errCount = 0;

  await Promise.all(targets.map((t, i) => limit(async () => {
    const source = t.url.includes('knia') || t.url.includes('samsungfire')
                 || t.url.includes('hi.co.kr') || t.url.includes('hwgeneralins')
                 || t.url.includes('directdb') || t.url.includes('kbinsure')
                 || t.url.includes('meritzfire') || t.url.includes('cancerok')
                 || t.url.includes('lotteins') || t.url.includes('axa')
                 || t.url.includes('heungkukfire') || t.url.includes('cyberinsu')
                 ? 'knia' : 'klia';
    const outPath = join(DATA_DIR, source, slug(t.insurer), `${slug(t.productName)}_${i}.pdf`);
    try {
      const r = await downloadPdf(t.url, outPath);
      if (r.skipped) { skipCount++; console.log(`[${i+1}/${targets.length}] skip ${t.insurer} ${t.productName}`); }
      else { okCount++; console.log(`[${i+1}/${targets.length}] ✓ ${t.insurer} ${t.productName} (${r.bytes ? (r.bytes/1024).toFixed(0) + 'KB' : 'ok'})`); }
      appendManifest({ ...t, pdfFile: outPath, downloadedAt: new Date().toISOString() });
    } catch (e) {
      errCount++;
      console.warn(`[${i+1}/${targets.length}] ✗ ${t.insurer} ${t.productName}: ${e.message}`);
    }
    await sleep(200); // rate-limit
  })));

  console.log(`=== 완료: 성공 ${okCount} / 스킵 ${skipCount} / 실패 ${errCount} ===`);
  console.log(`manifest: ${MANIFEST}`);
}

main().catch(err => {
  console.error('치명적 오류:', err);
  process.exit(1);
});
