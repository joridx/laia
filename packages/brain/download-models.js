#!/usr/bin/env node
/**
 * Download HuggingFace models manually (for networks that block LFS)
 * Run this from HOME network, then sync the cache to work PC.
 */

import { pipeline } from "@huggingface/transformers";
import fs from "fs";
import path from "path";

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const CACHE_DIR = path.join(process.cwd(), "node_modules", "@huggingface", "transformers", ".cache");

async function downloadModels() {
  console.log(`📦 Downloading model: ${MODEL_ID}`);
  console.log(`📁 Cache directory: ${CACHE_DIR}`);
  console.log("");

  try {
    // This will download the model files automatically
    console.log("⏳ Creating feature-extraction pipeline...");
    const extractor = await pipeline("feature-extraction", MODEL_ID, {
      dtype: "q8",
      progress_callback: (progress) => {
        if (progress.status === "download") {
          const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
          console.log(`   ${progress.file}: ${pct}%`);
        } else if (progress.status === "ready") {
          console.log(`   ✓ ${progress.file}`);
        }
      }
    });

    // Test embedding
    console.log("\n🧪 Testing embedding...");
    const result = await extractor("test string", { pooling: "mean", normalize: true });
    console.log(`✓ Embedding dimension: ${result.data.length}`);

    console.log("\n✅ Model downloaded successfully!");
    console.log("\n📂 Files location:");
    const modelPath = path.join(CACHE_DIR, "Xenova", "paraphrase-multilingual-MiniLM-L12-v2");
    if (fs.existsSync(modelPath)) {
      const files = fs.readdirSync(modelPath, { recursive: true });
      files.forEach(f => {
        const fullPath = path.join(modelPath, f);
        if (fs.statSync(fullPath).isFile()) {
          const size = (fs.statSync(fullPath).size / 1024 / 1024).toFixed(1);
          console.log(`   ${f} (${size} MB)`);
        }
      });
    }

    console.log("\n💾 To sync to another PC:");
    console.log(`   1. Zip: ${modelPath}`);
    console.log(`   2. Copy to work PC`);
    console.log(`   3. Extract to same path on work PC`);

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("\nIf download fails due to network restrictions:");
    console.error("1. Run this script from HOME network (no Zscaler)");
    console.error("2. Or download manually from HuggingFace:");
    console.error(`   https://huggingface.co/${MODEL_ID}/tree/main`);
    process.exit(1);
  }
}

downloadModels();
