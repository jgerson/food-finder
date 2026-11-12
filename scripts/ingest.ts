// One-time load: Food-101 (pre-embedded) -> Vercel Blob (images) -> turbopuffer (vectors + attributes).
//
//   npm run ingest -- --dry-run          read and resize only; no uploads, no keys needed
//   npm run ingest                       full load (needs TURBOPUFFER_API_KEY and BLOB_READ_WRITE_TOKEN)
//   npm run ingest -- --per-class 30     smaller subset
//
// No embedding happens here: each row already carries a 512-d OpenCLIP ViT-B-32 (laion2b_s34b_b79k) vector.
// Re-running is safe: Blob paths and turbopuffer ids are fixed, so rows are overwritten, not duplicated.
import * as lancedb from "@lancedb/lancedb";
import sharp from "sharp";
import { put } from "@vercel/blob";
import Turbopuffer from "@turbopuffer/turbopuffer";
import { courseOf, dishName } from "../lib/courses";

try { process.loadEnvFile(".env.local"); } catch { /* no .env.local: use the shell environment */ }

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const DATASET = "hf://datasets/lance-format/food101-lance/data";
const SPLIT = opt("split", "validation");
const PER_CLASS = Number(opt("per-class", "100"));
const NAMESPACE = process.env.TURBOPUFFER_NAMESPACE ?? "food101";
const DRY_RUN = flag("dry-run");
const BATCH = 250;
const UPLOAD_CONCURRENCY = 8;

type Source = { id: bigint | number; label_name: string; image: Uint8Array; image_emb: ArrayLike<number> };

async function main() {
  if (!DRY_RUN) {
    for (const key of ["TURBOPUFFER_API_KEY", "BLOB_READ_WRITE_TOKEN"]) {
      if (!process.env[key]) throw new Error(`${key} is not set. Add it to .env.local, or run with --dry-run.`);
    }
  }
  const tpuf = DRY_RUN ? null : new Turbopuffer({
    apiKey: process.env.TURBOPUFFER_API_KEY!,
    region: process.env.TURBOPUFFER_REGION || (process.env.TURBOPUFFER_BASE_URL ? undefined : "aws-us-east-1"),
  });
  const ns = tpuf?.namespace(NAMESPACE);

  const table = await (await lancedb.connect(DATASET)).openTable(SPLIT);
  console.log(`${SPLIT}: ${await table.countRows()} rows in the dataset`);

  // Pick the first PER_CLASS ids of each dish (a cheap scan of two small columns).
  const index = await table.query().select(["id", "label_name"]).toArray();
  const taken = new Map<string, number>();
  const ids: number[] = [];
  for (const r of index) {
    const n = taken.get(r.label_name) ?? 0;
    if (n < PER_CLASS) { ids.push(Number(r.id)); taken.set(r.label_name, n + 1); }
  }
  console.log(`Loading ${ids.length} images (${PER_CLASS} per dish, ${taken.size} dishes) into "${NAMESPACE}"${DRY_RUN ? " [dry run]" : ""}`);

  let done = 0;
  let bytes = 0;
  const started = Date.now();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const rows = (await table.query()
      .where(`id IN (${chunk.join(",")})`)
      .select(["id", "label_name", "image", "image_emb"])
      .toArray()) as Source[];

    const out = await mapLimit(rows, UPLOAD_CONCURRENCY, async (r) => {
      const id = Number(r.id);
      // Source images are 256x256 JPEGs; WebP at q80 is about a third of the size and looks the same.
      const webp = await sharp(Buffer.from(r.image)).webp({ quality: 80 }).toBuffer();
      bytes += webp.length;
      const path = `food101/${SPLIT}/${id}.webp`;
      const url = DRY_RUN ? `/dry-run/${path}` : (await put(path, webp, {
        access: "public",
        contentType: "image/webp",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 60 * 60 * 24 * 365,
      })).url;
      return {
        id: `${SPLIT}-${id}`,
        vector: Array.from(r.image_emb),
        url,
        label: r.label_name,
        dish: dishName(r.label_name),
        course: courseOf(r.label_name),
      };
    });

    if (ns) {
      await ns.write({
        upsert_rows: out,
        distance_metric: "cosine_distance",
        schema: {
          url: { type: "string", filterable: false },
          dish: { type: "string", filterable: false },
          label: { type: "string" },
          course: { type: "string" },
        },
      });
    } else if (i === 0) {
      console.log("Sample row:", { ...out[0], vector: `[${out[0].vector.length} floats]` });
    }

    done += out.length;
    const secs = (Date.now() - started) / 1000;
    console.log(`  ${done}/${ids.length}  (${(bytes / 1e6).toFixed(1)} MB of images, ${secs.toFixed(0)}s)`);
  }
  console.log(DRY_RUN ? "Dry run finished. Nothing was uploaded." : `Done. ${done} rows in turbopuffer namespace "${NAMESPACE}".`);
}

/** Like Promise.all(items.map(fn)) but with at most `limit` calls in flight. Keeps input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
