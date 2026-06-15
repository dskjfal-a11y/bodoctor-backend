/**
 * 02b_embed_existing_texts.js — v2 (메모리 효율·진단 강화)
 * ------------------------------------------------------------
 * 바탕화면/보험약관 폴더의 .txt 파일을 청크→Gemini Embedding→Pinecone upsert.
 *
 * 사용:
 *   node 02b_embed_existing_texts.js --create-index
 *   node 02b_embed_existing_texts.js --run
 *   node 02b_embed_existing_texts.js --run --reset
 *   node 02b_embed_existing_texts.js --stats     # 인덱스 통계만 조회
 *
 * v2 변경점:
 *   - 임베딩 배치 50 → 8 (메모리 ↓)
 *   - 청크 분할 후 즉시 비우기 (참조 해제)
 *   - 파일별로 즉시 stdout (버퍼링 X)
 *   - 임베딩 응답 검증 + 빈 응답 즉시 throw
 *   - upsert 후 인덱스 통계 재확인
 */

import 'dotenv/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { Pinecone } from '@pinecone-database/pinecone';

const TEXT_DIR = process.env.TEXT_DIR
  || 'C:\\Users\\김수찬\\OneDrive\\Desktop\\보험약관';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

for (const k of ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX', 'PINECONE_HOST']) {
  if (!process.env[k]) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIM = parseInt(process.env.EMBED_DIM || '3072', 10);

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

const log = (...a) => { console.log(...a); if (process.stdout.write) process.stdout.write(''); };

// ----- 인덱스 생성 -----
async function createIndex() {
  log(`Pinecone 인덱스 생성: ${process.env.PINECONE_INDEX} (dim=${EMBED_DIM})`);
  try {
    await pinecone.createIndex({
      name: process.env.PINECONE_INDEX,
      dimension: EMBED_DIM,
      metric: 'cosine',
      spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      waitUntilReady: true,
    });
    log('✓ 생성 완료. Pinecone 콘솔에서 Host URL을 복사해 .env의 PINECONE_HOST에 넣어주세요.');
  } catch (e) {
    if (/already exists|ALREADY_EXISTS/i.test(e.message)) log('ℹ️  인덱스 이미 존재. 건너뜀.');
    else throw e;
  }
}

// ----- 인덱스 통계 -----
async function stats() {
  const index = pinecone.index(process.env.PINECONE_INDEX, process.env.PINECONE_HOST);
  const s = await index.describeIndexStats();
  log('📊 인덱스 통계:', JSON.stringify(s, null, 2));
}

// ----- 청크 분할 -----
const CHUNK_CHARS = 700;
const OVERLAP_CHARS = 60;

function splitText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let pos = 0, idx = 0;
  while (pos < clean.length) {
    const end = Math.min(pos + CHUNK_CHARS, clean.length);
    const slice = clean.slice(pos, end);
    const lastPunct = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('。'), slice.lastIndexOf('.\n'));
    const cutAt = lastPunct > CHUNK_CHARS * 0.6 ? lastPunct + 1 : slice.length;
    const finalText = clean.slice(pos, pos + cutAt).trim();
    if (finalText.length > 50) chunks.push({ idx: idx++, text: finalText });
    pos += cutAt - OVERLAP_CHARS;
    if (pos <= 0 || cutAt <= 0) pos = end;
  }
  return chunks;
}

// ----- 메타 추출 -----
function extractMeta(text, fileName) {
  const lines = text.split('\n').slice(0, 10);
  const insurer = (lines.find(l => l.includes('[보험사]')) || '').replace(/.*\[보험사\]\s*/, '').trim() || '?';
  const productName = (lines.find(l => l.includes('[상품명]')) || '').replace(/.*\[상품명\]\s*/, '').trim() || '?';
  const generation = (lines.find(l => l.includes('[세대]')) || '').replace(/.*\[세대\]\s*/, '').trim() || '미상';
  return { insurer, productName, generation, fileName };
}

// ----- 임베딩 (배치 8, 검증) -----
async function embedSmallBatch(texts) {
  if (texts.length === 0) return [];
  const res = await genai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts.map(t => ({ parts: [{ text: t }] })),
    config: {
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EMBED_DIM,
    },
  });
  const embeddings = res.embeddings || (res.embedding ? [res.embedding] : []);
  if (embeddings.length !== texts.length) {
    throw new Error(`임베딩 응답 길이 불일치: 요청 ${texts.length}, 응답 ${embeddings.length}. 응답=${JSON.stringify(res).slice(0,300)}`);
  }
  return embeddings.map(e => {
    if (!e.values || e.values.length !== EMBED_DIM) {
      throw new Error(`임베딩 차원 불일치: 기대 ${EMBED_DIM}, 실제 ${e.values?.length}`);
    }
    return e.values;
  });
}

function ascii(s) {
  return Buffer.from(s, 'utf8').toString('base64url').slice(0, 480);
}

// ----- 메인 -----
async function run() {
  if (!existsSync(TEXT_DIR)) {
    console.error(`❌ 폴더 없음: ${TEXT_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(TEXT_DIR)
    .filter(f => f.endsWith('.txt') && !/(context|result|README)\.txt$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.error('❌ .txt 파일이 없습니다.');
    process.exit(1);
  }

  log(`📁 ${TEXT_DIR}`);
  log(`📄 ${files.length}개 파일 발견`);

  const index = pinecone.index(process.env.PINECONE_INDEX, process.env.PINECONE_HOST);

  if (args.reset) {
    log('🧹 인덱스 비우기 시도...');
    try {
      await index.deleteAll();
      log('   ✓ 삭제 완료');
    } catch (e) {
      log('   (이미 비어있거나 권한 부족, 무시):', e.message.slice(0, 100));
    }
  }

  let totalChunks = 0;
  let okFiles = 0;
  let errFiles = 0;

  for (let fi = 0; fi < files.length; fi++) {
    const fname = files[fi];
    const tag = `[${fi+1}/${files.length}]`;
    log(`\n▶ ${tag} ${fname}`);
    const fullPath = join(TEXT_DIR, fname);
    try {
      const text = readFileSync(fullPath, 'utf8');
      const meta = extractMeta(text, fname);
      log(`   메타: ${meta.insurer} / ${meta.productName.slice(0,40)} / ${meta.generation}`);

      const chunks = splitText(text);
      log(`   청크 ${chunks.length}개`);

      if (chunks.length === 0) { log('   (빈 파일 스킵)'); continue; }

      // 배치 8개씩 임베딩 + 즉시 upsert (메모리 누적 방지)
      const BATCH = 8;
      let upserted = 0;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const texts = slice.map(c => c.text);

        process.stdout.write(`   임베딩 ${i+1}~${i+slice.length}/${chunks.length}... `);
        const vectors = await embedSmallBatch(texts);
        process.stdout.write('OK. upsert... ');

        const ups = slice.map((c, j) => ({
          id: ascii(`${meta.insurer}|${meta.productName}|c${c.idx}`),
          values: vectors[j],
          metadata: {
            insurer: meta.insurer,
            productName: meta.productName,
            generation: meta.generation,
            fileName: meta.fileName,
            chunkIdx: c.idx,
            text: c.text.slice(0, 4000),
          },
        }));
        await index.upsert(ups);
        upserted += ups.length;
        process.stdout.write(`OK (${upserted}/${chunks.length})\n`);
      }

      totalChunks += chunks.length;
      okFiles++;
      log(`   ✓ ${tag} 완료 (${chunks.length}청크 적재)`);
    } catch (e) {
      errFiles++;
      console.error(`   ✗ ${tag} 실패:`, e.message);
    }
  }

  log(`\n=================`);
  log(`성공 파일: ${okFiles} / 실패 파일: ${errFiles} / 총 적재 청크: ${totalChunks}`);

  // upsert 후 인덱스 통계 재확인 (실제로 들어갔는지 검증)
  try {
    // Pinecone serverless는 적재 후 인덱싱 지연이 약간 있을 수 있음
    await new Promise(r => setTimeout(r, 3000));
    const s = await index.describeIndexStats();
    log(`📊 Pinecone 실제 통계: totalVectorCount=${s.totalRecordCount ?? s.totalVectorCount ?? '?'}`);
    log(`   namespaces=${JSON.stringify(s.namespaces || {})}`);
    if ((s.totalRecordCount ?? s.totalVectorCount ?? 0) === 0 && totalChunks > 0) {
      log('⚠️ 코드는 성공이라 했는데 Pinecone은 0건. PINECONE_HOST 또는 PINECONE_INDEX 불일치 가능.');
    }
  } catch (e) {
    log('통계 조회 실패:', e.message);
  }
}

// ----- 진입점 -----
if (args['create-index']) {
  createIndex().catch(e => { console.error(e); process.exit(1); });
} else if (args.stats) {
  stats().catch(e => { console.error(e); process.exit(1); });
} else if (args.run) {
  run().catch(e => { console.error(e); process.exit(1); });
} else {
  console.log('사용법:');
  console.log('  node 02b_embed_existing_texts.js --create-index');
  console.log('  node 02b_embed_existing_texts.js --run');
  console.log('  node 02b_embed_existing_texts.js --run --reset');
  console.log('  node 02b_embed_existing_texts.js --stats');
}
