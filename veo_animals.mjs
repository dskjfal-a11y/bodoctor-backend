/**
 * 춤추는 토끼 영상 — Google Veo 3.1 Fast (9:16 세로)
 * ------------------------------------------------------------
 * 실행: node veo_animals.mjs   (이 파일이 있는 백엔드 폴더에서)
 * - 같은 폴더 .env 의 GEMINI_API_KEY 자동 로드. Node 18+ 필요, npm 설치 불필요.
 * - 결과: rabbit_veo_<시각>.mp4
 *
 * ⚠️ Veo는 유료 티어 키에서만 동작. 초당 과금(Fast ≈ $0.10~0.15/초).
 * ⚠️ Veo 3.1 클립은 보통 8초가 기본. 10초가 필요하면 따로 이어붙이세요.
 *
 * ── 토끼 사진으로 만들고 싶다면 (image-to-video) ──
 *   1) 토끼 이미지를 이 폴더에 rabbit.jpg(또는 .png)로 저장
 *   2) 아래 IMAGE_PATH 에 파일명을 적으면 그 토끼를 첫 프레임으로 사용합니다.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 1) 프롬프트 (영어로 묘사할수록 결과가 좋음)
// ============================================================
const PROMPT = `Vertical 9:16 video. A hyperrealistic, irresistibly cute fluffy baby bunny with soft cream-beige fur, big glossy dark round eyes, rosy blushing cheeks and pink-tinted inner ears, standing upright on its two hind legs against a plain soft light-grey studio background.
The bunny dances with amazing rhythm and effortless sassy swagger to a smooth, soulful, chill foreign hip-hop groove — bouncing on the beat, cute body rolls, head bops, little paw moves, hips swaying — dancing skillfully yet staying adorably charming and playful. The fluffy fur jiggles and sways with every move.
Hyperrealistic CGI fur detail, soft even studio lighting, shallow depth of field. Joyful, sassy, viral social-media energy. Camera holds steady and centered, full-body framing.
Audio: a smooth, laid-back, soulful hip-hop / lo-fi beat with a catchy bassline. No text, no logos, no captions on screen.`;

// 이미지로 시작하려면 파일명을 넣으세요. 예: "rabbit.jpg" (비우면 텍스트만으로 생성)
const IMAGE_PATH = "";

const MODEL = "veo-3.1-fast-generate-preview"; // 저렴: veo-3.1-lite-generate-preview / 최고화질: veo-3.1-generate-preview
const ASPECT_RATIO = "9:16";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ============================================================
// 2) .env 에서 GEMINI_API_KEY 읽기
// ============================================================
function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env 파일을 찾을 수 없습니다: " + envPath);
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("GEMINI_API_KEY="));
  if (!line) throw new Error(".env 에 GEMINI_API_KEY 가 없습니다.");
  return line.slice("GEMINI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
}

const API_KEY = loadApiKey();
const headers = { "x-goog-api-key": API_KEY, "Content-Type": "application/json" };

function buildInstance() {
  const inst = { prompt: PROMPT };
  if (IMAGE_PATH) {
    const imgFull = path.join(__dirname, IMAGE_PATH);
    if (!fs.existsSync(imgFull)) throw new Error("이미지 파일을 찾을 수 없습니다: " + imgFull);
    const ext = path.extname(IMAGE_PATH).toLowerCase();
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    inst.image = { bytesBase64Encoded: fs.readFileSync(imgFull).toString("base64"), mimeType: mime };
    console.log("🖼️  이미지 기반(image-to-video):", IMAGE_PATH);
  }
  return inst;
}

async function main() {
  console.log("🐰 춤추는 토끼 영상 생성 (Veo 3.1 Fast, 9:16)");

  const startRes = await fetch(`${BASE_URL}/models/${MODEL}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [buildInstance()], parameters: { aspectRatio: ASPECT_RATIO } }),
  });
  const startText = await startRes.text();
  if (!startRes.ok) {
    console.error(`\n❌ 생성 요청 실패 (HTTP ${startRes.status}):\n${startText}`);
    if (startRes.status === 403 || /PERMISSION|billing|quota/i.test(startText))
      console.error("\n👉 이 키가 '유료 티어(결제 연결)' 인지 확인하세요. Veo는 무료 키로는 동작하지 않습니다.");
    process.exit(1);
  }

  const opName = JSON.parse(startText).name;
  console.log("⏳ 작업 생성됨:", opName, "\n   보통 1~3분 걸립니다...");

  const deadline = Date.now() + 8 * 60 * 1000;
  let status;
  while (true) {
    if (Date.now() > deadline) { console.error("❌ 시간 초과(8분)."); process.exit(1); }
    await new Promise((r) => setTimeout(r, 10000));
    status = await (await fetch(`${BASE_URL}/${opName}`, { headers })).json();
    if (status.error) { console.error("❌ 생성 오류:", JSON.stringify(status.error, null, 2)); process.exit(1); }
    if (status.done) break;
    console.log("   ...생성 중");
  }

  const uri = status?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) { console.error("❌ 영상 URI 없음. 응답:\n", JSON.stringify(status, null, 2)); process.exit(1); }

  console.log("⬇️  다운로드 중...");
  const videoRes = await fetch(uri, { headers, redirect: "follow" });
  if (!videoRes.ok) { console.error(`❌ 다운로드 실패 (HTTP ${videoRes.status})`); process.exit(1); }
  const buf = Buffer.from(await videoRes.arrayBuffer());
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const outPath = path.join(__dirname, `rabbit_veo_${stamp}.mp4`);
  fs.writeFileSync(outPath, buf);
  console.log(`\n✅ 완료! 저장됨:\n   ${outPath}\n   (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => { console.error("❌ 예외:", e.message); process.exit(1); });
