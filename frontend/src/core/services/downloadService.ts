export interface DownloadRequest {
  data: Blob | File;
  filename: string;
  localPath?: string;
}

export interface DownloadResult {
  savedPath?: string;
  cancelled?: boolean;
}

/**
 * Embed-Hook (BIK fork): Wenn Stirling-PDF in einem iframe läuft, sendet
 * jeder Download zusätzlich ein postMessage-Event an das Parent-Frame.
 * Damit kann der Embedder (z.B. ein Drive-/CMS-System) die bearbeitete
 * PDF auffangen und automatisch als neue Version persistieren — ohne
 * dass der User die Datei manuell wieder hochladen muss.
 *
 * Aktiviert nur wenn:
 *   1. Wir tatsächlich in einem iframe sind (window !== window.parent)
 *   2. Eine optional konfigurierte `STIRLING_EMBED_TARGET_ORIGIN`-Var
 *      steht ODER targetOrigin="*" wird als Fallback genutzt (sicher
 *      genug weil wir nur Bytes senden, keine sensitiven Tokens)
 *
 * Event-Shape:
 *   {
 *     type: "stirling:save",
 *     filename: string,
 *     mimeType: string,
 *     size: number,
 *     bytes: ArrayBuffer,        // Übertragable, kein deep-copy
 *     timestamp: number,
 *   }
 *
 * Der Browser-Download läuft GLEICHZEITIG weiter — der User hat also
 * weiterhin sein lokales File, falls der Embedder den Hook nicht
 * konsumiert. Zero-Regression-Pfad für Standalone-Use.
 */
async function postMessageToEmbedder(
  data: Blob | File,
  filename: string,
): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    if (window === window.parent) return; // standalone, no embed

    const buf = await data.arrayBuffer();
    const targetOrigin =
      (window as unknown as { STIRLING_EMBED_TARGET_ORIGIN?: string })
        .STIRLING_EMBED_TARGET_ORIGIN || "*";

    window.parent.postMessage(
      {
        type: "stirling:save",
        filename,
        mimeType:
          (data as Blob).type || "application/octet-stream",
        size: data.size,
        bytes: buf,
        timestamp: Date.now(),
      },
      targetOrigin,
      [buf], // transferable — keine Kopie nötig
    );
  } catch (e) {
    // Embedder-Hook ist eine Erweiterung, kein Pflicht-Pfad. Ein
    // postMessage-Fehler darf den Standard-Download nicht blocken.
    // eslint-disable-next-line no-console
    console.warn("[stirling embed-hook] postMessage failed:", e);
  }
}

export async function downloadFile(
  request: DownloadRequest,
): Promise<DownloadResult> {
  // Embedder-Hook FIRST so the parent gets the bytes even if the
  // browser download is blocked or canceled by user policy.
  await postMessageToEmbedder(request.data, request.filename);

  const url = URL.createObjectURL(request.data);

  const link = document.createElement("a");
  link.href = url;
  link.download = request.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);

  return { savedPath: request.localPath };
}

export async function downloadFromUrl(
  url: string,
  filename: string,
  localPath?: string,
): Promise<DownloadResult> {
  // For URL-based downloads we can't easily fetch+postMessage without
  // CORS hassle, so we leave the standard browser download path. The
  // primary save-flow goes through downloadFile() which has the hook.
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  return { savedPath: localPath };
}
