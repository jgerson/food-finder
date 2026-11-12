// Web Worker: turns a text query or a photo into a 512-d CLIP vector, in the browser.
//
// It must be the same model that embedded the dataset: OpenCLIP ViT-B-32, laion2b_s34b_b79k.
// The q8 (8-bit) build is 150 MB instead of 600 MB; on held-out Food-101 photos it retrieves the right dish
// as often as the dataset's own vectors do. The browser caches the model after the first visit.
import { AutoProcessor, AutoTokenizer, CLIPModel, RawImage, Tensor, env } from "@huggingface/transformers";

const MODEL = "onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX";
env.allowLocalModels = false;

type Req = { id: number; type: "load" } | { id: number; type: "text"; text: string } | { id: number; type: "image"; image: Blob };

let ready: Promise<{ model: CLIPModel; tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> }> | null = null;

function load() {
  ready ??= (async () => {
    // Progress per file; the UI shows the total across the model files.
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total });
    };
    const [model, tokenizer, processor] = await Promise.all([
      CLIPModel.from_pretrained(MODEL, { dtype: "q8", device: "wasm", progress_callback }),
      AutoTokenizer.from_pretrained(MODEL, { progress_callback }),
      AutoProcessor.from_pretrained(MODEL, { progress_callback }),
    ]);
    return { model, tokenizer, processor };
  })();
  return ready;
}

function normalize(data: Float32Array): number[] {
  let n = 0;
  for (const x of data) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(data, (x) => x / n);
}

// This ONNX file holds both encoders and wants both inputs on every call, so the unused side gets a
// placeholder (a short caption or a blank image). Only the side we need is read from the output.
async function embedText(text: string) {
  const { model, tokenizer } = await load();
  const tokens = tokenizer([`a photo of ${text}, a type of food.`], { padding: true, truncation: true });
  const blank = new Tensor("float32", new Float32Array(3 * 224 * 224), [1, 3, 224, 224]);
  const out = await model({ ...tokens, pixel_values: blank });
  return normalize(out.text_embeds.data as Float32Array);
}

async function embedImage(blob: Blob) {
  const { model, tokenizer, processor } = await load();
  const image = await RawImage.fromBlob(blob);
  const pixels = await processor(image);
  const out = await model({ ...tokenizer(["a photo"], { padding: true }), ...pixels });
  return normalize(out.image_embeds.data as Float32Array);
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    if (req.type === "load") {
      await load();
      self.postMessage({ id: req.id, type: "ready" });
    } else {
      const t0 = performance.now();
      const vector = req.type === "text" ? await embedText(req.text) : await embedImage(req.image);
      self.postMessage({ id: req.id, type: "vector", vector, ms: Math.round(performance.now() - t0) });
    }
  } catch (err) {
    self.postMessage({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
