# Conventions for this repo

- This is a personal learning project. Keep the README's personal-project note.
- Never commit keys. Settings come from environment variables (`.env.local` locally, Vercel project settings in production).
- Never commit chat logs or AI session transcripts.
- Do not include Claude-Session links in commit messages or PR descriptions.
- Query embeddings must use the same model as the dataset's vectors: OpenCLIP ViT-B-32 `laion2b_s34b_b79k`
  (`onnx-community/CLIP-ViT-B-32-laion2B-s34B-b79K-ONNX`). OpenAI's CLIP ViT-B/32 does not match.
