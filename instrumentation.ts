// Runs once when a server instance starts. Sets up Langfuse tracing (a no-op without Langfuse keys).
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureLangfuse } = await import("./lib/langfuse-setup");
    ensureLangfuse();
  }
}
