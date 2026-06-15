/**
 * 보닥터 홍보영상 생성 — Google Veo 3.1 Fast (9:16 세로)
 * ------------------------------------------------------------
 * 실행 방법 (이 파일이 있는 백엔드 폴더에서):
 *     node veo_bodoctor.mjs
 *
 * - 같은 폴더의 .env 에서 GEMINI_API_KEY 를 자동으로 읽습니다.
 * - Node 18+ 필요 (전역 fetch 사용). npm 설치 불필요.
 * - 결과 mp4는 같은 폴더에 bodoctor_veo_<시각>.mp4 로 저장됩니다.
 *
 * ⚠️ Veo는 Gemini API '유료(paid) 티어' 에서만 동작합니다.
 *    무료 키면 403/PERMISSION 오류가 납니다. 결제 연결된 프로젝트 키여야 해요.
 * ⚠️ 초당 과금됩니다 (Fast ≈ $0.10~0.15/초, 8초 ≈ $0.8~1.2).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 1) 여기서 프롬프트를 자유롭게 수정하세요 (영어로 묘사할수록 결과가 좋습니다)
// ============================================================
const PROMPT = `Black-and-white cinematic film, 9:16 vertical. A Korean man in his early 40s with a distinctly Korean face stands completely still on a busy downtown city street at night. He does not walk or move his body — he remains motionless. Passersby and glowing neon signs are blurred far out of focus behind him. He wears a dark short-sleeved shirt.
The shot begins on a calm, blank, expressionless face. Only the camera moves: it slowly and steadily pushes in, tightening from a medium shot into an intimate close-up. As it closes in, his eyes lift to meet the camera lens, and the faintest, most restrained trace of a bittersweet smile surfaces — deeply controlled and understated, the emotion held quietly behind his eyes rather than shown openly; his eyes glisten almost imperceptibly. Subtle, minimal, never exaggerated.
Shallow depth of field, soft bokeh from the city lights behind him. Slow, smooth, steady camera push-in. High-contrast black and white, fine film grain, a soft key light coming from one side. Calm, introspective, premium documentary tone.
Audio: a slow, dreamy, profound ambient orchestral score — deep swelling organ, sparse echoing piano notes, ethereal and cosmic, melancholic and meditative. No dialogue. No text, no logos, no captions anywhere on screen.`;

const MODEL = "veo-3.1-fast-generate-preview"; // 더 저렴: veo-3.1-lite-generate-preview / 최고화질: veo-3.1-generate-preview
const ASPECT_RATIO = "9:16";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// ============================================================
// 2) .env 에서 GEMINI_API_KEY 읽기
// ============================================================
function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env 파일을 찾을 수 없습니다: " + envPath);
  }
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("GEMINI_API_KEY="));
  if (!line) throw new Error(".env 에 GEMINI_API_KEY 가 없습니다.");
  return line.slice("GEMINI_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
}

const API_KEY = loadApiKey();
const headers = { "x-goog-api-key": API_KEY, "Content-Type": "application/json" };

async function main() {
  console.log("🎬 보닥터 홍보영상 생성 시작 (Veo 3.1 Fast, 9:16)");
  console.log("   모델:", MODEL);

  // ---- 생성 요청 ----
  const startRes = await fetch(`${BASE_URL}/models/${MODEL}:predictLongRunning`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      instances: [{ prompt: PROMPT }],
      parameters: { aspectRatio: ASPECT_RATIO },
    }),
  });

  const startText = await startRes.text();
  if (!startRes.ok) {
    console.error(`\n❌ 생성 요청 실패 (HTTP ${startRes.status}):\n${startText}`);
    if (startRes.status === 403 || /PERMISSION|billing|quota/i.test(startText)) {
      console.error("\n👉 이 키가 '유료 티어(결제 연결)' 인지 확인하세요. Veo는 무료 키로는 동작하지 않습니다.");
    }
    process.exit(1);
  }

  const opName = JSON.parse(startText).name;
  console.log("⏳ 작업 생성됨:", opName);
  console.log("   영상 생성에는 보통 1~3분 걸립니다...");

  // ---- 폴링 ----
  const deadline = Date.now() + 8 * 60 * 1000; // 최대 8분
  let status;
  while (true) {
    if (Date.now() > deadline) {
      console.error("❌ 시간 초과(8분). 나중에 다시 시도해주세요.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 10000));
    const pollRes = await fetch(`${BASE_URL}/${opName}`, { headers });
    status = await pollRes.json();
    if (status.error) {
      console.error("❌ 생성 오류:", JSON.stringify(status.error, null, 2));
      process.exit(1);
    }
    if (status.done) break;
    console.log("   ...생성 중");
  }

  // ---- 다운로드 ----
  const uri =
    status?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!uri) {
    console.error("❌ 영상 URI를 찾지 못했습니다. 전체 응답:\n", JSON.stringify(status, null, 2));
    process.exit(1);
  }

  console.log("⬇️  영상 다운로드 중...");
  const videoRes = await fetch(uri, { headers, redirect: "follow" });
  if (!videoRes.ok) {
    console.error(`❌ 다운로드 실패 (HTTP ${videoRes.status})`);
    process.exit(1);
  }
  const buf = Buffer.from(await videoRes.arrayBuffer());
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const outPath = path.join(__dirname, `bodoctor_veo_${stamp}.mp4`);
  fs.writeFileSync(outPath, buf);

  console.log(`\n✅ 완료! 저장됨:\n   ${outPath}`);
  console.log(`   (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error("❌ 예외:", e.message);
  process.exit(1);
});
