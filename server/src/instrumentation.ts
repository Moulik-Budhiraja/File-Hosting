export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmPreviewMediaTools } =
    await import("./server/files/preview-renderers");
  await warmPreviewMediaTools();
}
