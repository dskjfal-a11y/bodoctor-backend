/**
 * 02_parse_chunk_embed.js
 * ------------------------------------------------------------
 * 2단계 PDF 텍스트 파싱
 * 3단계 500토큰 단위 청크 분할 (페이지 번호·메타데이터 포함)
 * 4단계 Gemini Embedding API로 벡터화 (gemini-embedding-001)
 * 5단계 Pinecone에 upsert
 *
 * 사용:
 *   node 02_parse_chunk_embed.js --create-index   # Pinecone 인덱스 생성 (1회)
 *   node 02_parse_chunk_embed.js --run            # 파이프라인 실행
 *   node 02_parse_chunk_embed.js --run --resume   # 이미 처리한 PDF 스킵
 *
 * 환경변수: GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX, PINECONE_HOST, EMBED_DIM
 */

import 'dotenv/config';
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { GoogleGenAI } from '@google/genai';
import { Pinecone } from '@pinecone-database/pinecone';
import pLimit from 'p-limit';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const PDF_DIR = join(DATA_DIR, 'pdfs');
const CHUNK_DIR = join(DATA_DIR, 'chunks');
const MANIFEST = join(PDF_DIR, 'manifest.jsonl');
const PROCESSED_LOG = join(DATA_DIR, 'processed.log');

mkdirSync(CHUNK_DIR, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

// ---------- 환경변수 검증 ----------
const REQ_ENV = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX', 'PINECONE_HOST'];
for (const k of REQ_ENV) {
  if (!process.env[k]) {
    console.error(`❌ 환경변수 누락: ${k}`);
    process.exit(1);
  }
}
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const EMBED_DIM = parseInt(process.env.EMBED_DIM || '3072', 10);

// ---------- 클라이언트 ----------
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

// ============================================================
// 인덱스 생성 (1회)
// ============================================================
async function createIndex() {
  console.log(`Pinecone 인덱스 생성: ${process.env.PINECONE_INDEX} (dim=${EMBED_DIM})`);
  await pinecone.createIndex({
    name: process.env.PINECONE_INDEX,
    dimension: EMBED_DIM,
    metric: 'cosine',
    spec: {
      serverless: {
        cloud: 'aws',
        region: 'us-east-1',
      },
    },
    waitUntilReady: true,
  });
  console.log('✓ 인덱스 생성 완료');
}

// ============================================================
// 청크 분할 (500 토큰 ≈ 약 1,500자 한국어 기준, 페이지 단위 보존)
// ============================================================
const CHUNK_TOKENS = 500;
const CHUNK_OVERLAP = 50;
// 한국어 토큰 추정: 평균 한 글자 ≈ 0.7 토큰 → 500토큰 ≈ 약 700자. 보수적으로 600자로 설정.
const CHUNK_CHARS = Math.floor(CHUNK_TOKENS * 1.2);
const OVERLAP_CHARS = Math.floor(CHUNK_OVERLAP * 1.2);

function splitIntoChunks(pages /* [{page, text}] */) {
  const chunks = [];
  let chunkIdx = 0;

  for (const { page, text } of pages) {
    if (!text || text.length < 20) continue;
    const clean = text.replace(/\s+/g, ' ').trim();
    let pos = 0;
    while (pos < clean.length) {
      const end = Math.min(pos + CHUNK_CHARS, clean.length);
      const slice = clean.slice(pos, end);
      // 가능한 경우 문장 경계에서 자르기
      const lastPeriod = slice.lastIndexOf('. ');
      const cutAt = lastPeriod > CHUNK_CHARS * 0.6 ? lastPeriod + 1 : slice.length;
      const finalText = clean.slice(pos, pos + cutAt).trim();
      if (finalText.length > 50) {
        chunks.push({ chunkIdx: chunkIdx++, page, text: finalText });
      }
      pos += cutAt - OVERLAP_CHARS;
      if (pos <= 0) pos = end; // 안전장치
    }
  }
  return chunks;
}

// ============================================================
// PDF → 페이지별 텍스트
// ============================================================
async function pdfToPages(pdfPath) {
  const buffer = readFileSync(pdfPath);
  // pdf-parse는 전체 텍스트를 한 번에 주므로, 페이지 구분자(\f, \n\n 등)로 추정 분리
  const result = await pdfParse(buffer);
  const rawText = result.text || '';
  const pageTexts = rawText.split(/\f|\n\s*\n\s*\n/).filter(t => t.trim().length > 0);
  return pageTexts.map((text, idx) => ({ page: idx + 1, text }));
}

// ============================================================
// Gemini Embedding
// ============================================================
async function embedTexts(texts) {
  // gemini-embedding-001은 batch 지원 (최대 100개/요청)
  const batchSize = 50;
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await genai.models.embedContent({
      model: EMBED_MODEL,
      contents: batch.map(t => ({ parts: [{ text: t }] })),
      config: {
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: EMBED_DIM,
      },
    });
    const embeddings = res.embeddings || (res.embedding ? [res.embedding] : []);
    for (const e of embeddings) out.push(e.values);
  }
  return out;
}

// ============================================================
// Pinecone Upsert
// ============================================================
function ascii(s) {
  // Pinecone vector ID는 ASCII만 허용 → 한글은 base64로 변환
  return Buffer.from(s, 'utf8').toString('base64url');
}

async function upsertChunks(insurer, productName, pdfFile, chunks, vectors, generation) {
  const index = pinecone.index(process.env.PINECONE_INDEX, process.env.PINECONE_HOST);
  const vectorsToUpsert = chunks.map((c, i) => ({
    id: ascii(`${insurer}|${productName}|p${c.page}|c${c.chunkIdx}`),
    values: vectors[i],
    metadata: {
      insurer,
      productName,
      generation: generation || '미상',
      pdfFile,
      page: c.page,
      chunkIdx: c.chunkIdx,
      text: c.text.slice(0, 4000), // Pinecone metadata 한계 고려
    },
  }));
  // 100개씩 batch
  for (let i = 0; i < vectorsToUpsert.length; i += 100) {
    await index.upsert(vectorsToUpsert.slice(i, i + 100));
  }
}

// ============================================================
// 메인 파이프라인
// ============================================================
function loadManifest() {
  if (!existsSync(MANIFEST)) {
    console.error(`❌ manifest 없음: ${MANIFEST}. 먼저 01_crawl_disclosures.js를 실행하세요.`);
    process.exit(1);
  }
  return readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function loadProcessed() {
  if (!existsSync(PROCESSED_LOG)) return new Set();
  return new Set(readFileSync(PROCESSED_LOG, 'utf8').split('\n').filter(Boolean));
}

function markProcessed(pdfFile) {
  appendFileSync(PROCESSED_LOG, pdfFile + '\n');
}

async function run() {
  const manifest = loadManifest();
  const processed = args.resume ? loadProcessed() : new Set();
  const todo = manifest.filter(m => !processed.has(m.pdfFile) && existsSync(m.pdfFile));
  console.log(`총 ${manifest.length}개 중 ${todo.length}개 처리 예정`);

  const limit = pLimit(2); // Gemini API rate-limit 고려 (분당 호출 수 제한)
  let okCount = 0, errCount = 0, totalChunks = 0;

  await Promise.all(todo.map((m, idx) => limit(async () => {
    try {
      console.log(`[${idx+1}/${todo.length}] 파싱 ${m.insurer} ${m.productName}`);
      const pages = await pdfToPages(m.pdfFile);
      if (pages.length === 0) {
        console.warn(`  ⚠️ 빈 PDF, 스킵`);
        return;
      }
      const chunks = splitIntoChunks(pages);
      if (chunks.length === 0) return;

      console.log(`  → ${pages.length}페이지, ${chunks.length}청크 임베딩...`);
      const vectors = await embedTexts(chunks.map(c => c.text));

      console.log(`  → Pinecone upsert...`);
      await upsertChunks(m.insurer, m.productName, m.pdfFile, chunks, vectors, m.generation);

      markProcessed(m.pdfFile);
      okCount++;
      totalChunks += chunks.length;
      console.log(`  ✓ 완료 (${chunks.length}청크)`);
    } catch (e) {
      errCount++;
      console.error(`  ✗ ${m.pdfFile}: ${e.message}`);
    }
  })));

  console.log(`\n=== 파이프라인 완료 ===`);
  console.log(`성공: ${okCount} / 실패: ${errCount} / 총 청크: ${totalChunks}`);
}

// ============================================================
// 진입점
// ============================================================
if (args['create-index']) {
  createIndex().catch(e => { console.error(e); process.exit(1); });
} else if (args.run) {
  run().catch(e => { console.error(e); process.exit(1); });
} else {
  console.log('사용법:');
  console.log('  node 02_parse_chunk_embed.js --create-index   # Pinecone 인덱스 생성 (1회)');
  console.log('  node 02_parse_chunk_embed.js --run            # 파이프라인 실행');
  console.log('  node 02_parse_chunk_embed.js --run --resume   # 이어서 처리');
}
