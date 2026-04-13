// ─── Screenshot Utility ───────────────────────────────────────────────────────
// Capture and upload failure screenshots to Supabase Storage

import { BrowserContext } from "playwright";
import { config } from "../server";

export async function uploadScreenshot(
  buffer: Buffer,
  label: string
): Promise<string | null> {
  if (!config.supabaseUrl || !config.supabaseKey) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${label}_${timestamp}.png`;

  try {
    const response = await fetch(
      `${config.supabaseUrl}/storage/v1/object/screenshots/${filename}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
        },
        body: buffer,
      }
    );

    if (response.ok) {
      const publicUrl = `${config.supabaseUrl}/storage/v1/object/public/screenshots/${filename}`;
      console.log(`[Screenshot] Uploaded: ${filename}`);
      return publicUrl;
    } else {
      console.error(`[Screenshot] Upload failed: ${await response.text()}`);
      return null;
    }
  } catch (err) {
    console.error(`[Screenshot] Error: ${(err as Error).message}`);
    return null;
  }
}

export async function captureFailure(
  context: BrowserContext | null,
  label: string
): Promise<string | null> {
  if (!context) return null;
  try {
    const pages = context.pages();
    if (pages.length === 0) return null;
    const buffer = await pages[0].screenshot({ fullPage: true });
    return await uploadScreenshot(buffer, label);
  } catch {
    return null;
  }
}
