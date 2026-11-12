"use client";
// React hook around the CLIP worker: starts the model download on mount and exposes embed calls.
import { useCallback, useEffect, useRef, useState } from "react";

export type ModelState =
  | { status: "loading"; loaded: number; total: number }
  | { status: "ready" }
  | { status: "error"; message: string };

type Pending = { resolve: (v: { vector: number[]; ms: number }) => void; reject: (e: Error) => void };

export function useClip() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const nextId = useRef(1);
  const files = useRef(new Map<string, { loaded: number; total: number }>());
  const [state, setState] = useState<ModelState>({ status: "loading", loaded: 0, total: 0 });

  useEffect(() => {
    const w = new Worker(new URL("./clip.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") {
        files.current.set(m.file, { loaded: m.loaded ?? 0, total: m.total ?? 0 });
        let loaded = 0, total = 0;
        for (const f of files.current.values()) { loaded += f.loaded; total += f.total; }
        setState((s) => (s.status === "ready" ? s : { status: "loading", loaded, total }));
        return;
      }
      if (m.type === "ready") { setState({ status: "ready" }); return; }
      const p = pending.current.get(m.id);
      if (!p) {
        if (m.type === "error") setState({ status: "error", message: m.message });
        return;
      }
      pending.current.delete(m.id);
      if (m.type === "vector") p.resolve({ vector: m.vector, ms: m.ms });
      else p.reject(new Error(m.message));
    };
    w.postMessage({ id: 0, type: "load" });
    return () => w.terminate();
  }, []);

  const call = useCallback((msg: { type: "text"; text: string } | { type: "image"; image: Blob }) => {
    const id = nextId.current++;
    return new Promise<{ vector: number[]; ms: number }>((resolve, reject) => {
      pending.current.set(id, { resolve, reject });
      worker.current?.postMessage({ id, ...msg });
    });
  }, []);

  const embedText = useCallback((text: string) => call({ type: "text", text }), [call]);
  const embedImage = useCallback((image: Blob) => call({ type: "image", image }), [call]);
  return { state, embedText, embedImage };
}
