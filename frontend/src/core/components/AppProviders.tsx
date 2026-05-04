import { ReactNode, useEffect, useRef } from "react";
import { RainbowThemeProvider } from "@app/components/shared/RainbowThemeProvider";
import { FileContextProvider, useFileContext } from "@app/contexts/FileContext";
import { useFileState } from "@app/contexts/file/fileHooks";
import { NavigationProvider } from "@app/contexts/NavigationContext";
import { ToolRegistryProvider } from "@app/contexts/ToolRegistryProvider";
import { FilesModalProvider } from "@app/contexts/FilesModalContext";
import { ToolWorkflowProvider } from "@app/contexts/ToolWorkflowContext";
import { HotkeyProvider } from "@app/contexts/HotkeyContext";
import { SidebarProvider } from "@app/contexts/SidebarContext";
import {
  PreferencesProvider,
  usePreferences,
} from "@app/contexts/PreferencesContext";
import {
  AppConfigProvider,
  AppConfigProviderProps,
  AppConfigRetryOptions,
  useAppConfig,
} from "@app/contexts/AppConfigContext";
import { RightRailProvider } from "@app/contexts/RightRailContext";
import { ViewerProvider } from "@app/contexts/ViewerContext";
import { SignatureProvider } from "@app/contexts/SignatureContext";
import { AnnotationProvider } from "@app/contexts/AnnotationContext";
import { TourOrchestrationProvider } from "@app/contexts/TourOrchestrationContext";
import { AdminTourOrchestrationProvider } from "@app/contexts/AdminTourOrchestrationContext";
import { PageEditorProvider } from "@app/contexts/PageEditorContext";
import { BannerProvider } from "@app/contexts/BannerContext";
import ErrorBoundary from "@app/components/shared/ErrorBoundary";
import { useScarfTracking } from "@app/hooks/useScarfTracking";
import { useAppInitialization } from "@app/hooks/useAppInitialization";
import { useLogoAssets } from "@app/hooks/useLogoAssets";
import AppConfigLoader from "@app/components/shared/AppConfigLoader";
import { RedactionProvider } from "@app/contexts/RedactionContext";
import { FormFillProvider } from "@app/tools/formFill/FormFillContext";

// Component to initialize scarf tracking (must be inside AppConfigProvider)
function ScarfTrackingInitializer() {
  useScarfTracking();
  return null;
}

// Component to run app-level initialization (must be inside AppProviders for context access)
function AppInitializer() {
  useAppInitialization();
  return null;
}

/**
 * Embedder-Bridge (BIK fork): Wenn Stirling-PDF als iframe in eine
 * Host-App eingebettet ist, kann diese ein PDF programmatisch
 * vorabladen und so den Drag-Drop-Schritt überspringen. Erwartet
 * folgendes postMessage:
 *
 *   window.parent → iframe.contentWindow:
 *     {
 *       type: "stirling:load",
 *       bytes: ArrayBuffer,
 *       filename: string,
 *       mimeType?: string,   // default "application/pdf"
 *     }
 *
 * Wir fangen das hier ab und reichen die File via FileContext-Action
 * `addFilesWithOptions` ins normale File-Manager-System ein — gleicher
 * Pfad wie ein User-Drop oder File-Picker. Optional `selectFiles=true`
 * damit das geladene File automatisch aktiv ist.
 *
 * No-op wenn nicht im iframe (window === window.parent).
 */
function EmbedderBridge() {
  const { actions, selectors } = useFileContext();
  const { state } = useFileState();

  // Auto-Save-Watcher: Sobald der aktive File sich ändert (z.B. nach
  // "Bilder anwenden" produziert createStampTool via consumeFiles eine
  // neue Version), schicken wir die Bytes via stirling:save an den
  // Embedder. So muss der User nicht mehr auf "Download" klicken —
  // der Speichern-Status oben in der PDB-Toolbar springt automatisch
  // auf "Gespeichert vor Xs".
  //
  // Wir skippen die initiale stirling:load-Aktivierung (sonst saven
  // wir die Datei, die wir gerade selbst geladen haben).
  const lastSeenFileIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const selectedIds = state.ui.selectedFileIds;
  const activeFileId = selectedIds.length === 1 ? selectedIds[0] : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window === window.parent) return; // standalone, kein Embed
    if (!activeFileId) return;

    // First active file = our initial stirling:load → don't auto-save it
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSeenFileIdRef.current = activeFileId;
      return;
    }
    // Same file (no version bump) — nothing to save
    if (lastSeenFileIdRef.current === activeFileId) return;

    const file = selectors.getFile(activeFileId);
    if (!file) return;

    lastSeenFileIdRef.current = activeFileId;

    // Bytes lesen + an Parent posten. Async, aber Listener bleibt
    // beim Watcher-Tick reaktiv für die nächste Änderung.
    void (async () => {
      try {
        const buf = await file.arrayBuffer();
        const filename = file.name || "edited.pdf";
        const mimeType = file.type || "application/pdf";
        // eslint-disable-next-line no-console
        console.log("[stirling embed-bridge] auto-save:", {
          filename,
          size: buf.byteLength,
        });
        window.parent.postMessage(
          {
            type: "stirling:save",
            filename,
            mimeType,
            size: buf.byteLength,
            bytes: buf,
            timestamp: Date.now(),
          },
          "*",
          [buf],
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[stirling embed-bridge] auto-save failed:", e);
      }
    })();
  }, [activeFileId, selectors]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window === window.parent) return; // standalone, kein Embed

    function onMessage(ev: MessageEvent) {
      const data = ev.data as
        | {
            type?: string;
            bytes?: ArrayBuffer;
            filename?: string;
            mimeType?: string;
          }
        | undefined;
      if (!data || data.type !== "stirling:load") return;
      if (!data.bytes || !(data.bytes instanceof ArrayBuffer)) return;

      try {
        const file = new File(
          [data.bytes],
          data.filename || "embedded.pdf",
          { type: data.mimeType || "application/pdf" },
        );
        // Bei Version-Switch im Embed-Modus liegt bereits eine
        // Vorgänger-Version im FileContext. Wir entfernen ALLE
        // existierenden Files bevor wir die neue laden — sonst
        // greift `allowDuplicates: false` und Stirling rejected
        // den Push (gleicher Filename), oder `allowDuplicates: true`
        // produziert eine wachsende Liste die der User nie clearen
        // kann (UI dafür ist beim Embed ausgeblendet).
        //
        // Beim Initial-Load (kein File da) ist removeFiles ein
        // No-op → kein Performance-Hit für den Cold-Start-Pfad.
        void (async () => {
          try {
            const existingIds = selectors.getAllFileIds();
            if (existingIds.length > 0) {
              await actions.removeFiles(existingIds, false);
            }
            await actions.addFilesWithOptions([file], {
              selectFiles: true,
              allowDuplicates: true,
            });
            // Auto-Save-Watcher würde jetzt fälschlicherweise den
            // gerade geladenen File als "Änderung" interpretieren
            // und ihn ans Drive zurückspielen. Wir resetten den
            // Init-Marker damit der nächste Active-File-Wechsel
            // wieder als initial erkannt wird.
            initializedRef.current = false;
            lastSeenFileIdRef.current = null;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[stirling embed-bridge] load failed:", err);
          }
        })();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[stirling embed-bridge] could not parse load event:", e);
      }
    }

    window.addEventListener("message", onMessage);
    // Beim Mount: signalisieren dass wir bereit sind. Der Embedder
    // kann darauf warten statt blind zu schicken — verhindert Race-
    // Condition wenn Stirling-Bundle noch nicht geladen ist.
    try {
      window.parent.postMessage({ type: "stirling:ready" }, "*");
    } catch {
      // ignore — postMessage to parent rarely fails, but be defensive
    }
    return () => window.removeEventListener("message", onMessage);
  }, [actions, selectors]);

  return null;
}

function BrandingAssetManager() {
  const { favicon, logo192, manifestHref } = useLogoAssets();

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const setLinkHref = (selector: string, href: string) => {
      const link = document.querySelector<HTMLLinkElement>(selector);
      if (link && link.getAttribute("href") !== href) {
        link.setAttribute("href", href);
      }
    };

    setLinkHref('link[rel="icon"]', favicon);
    setLinkHref('link[rel="shortcut icon"]', favicon);
    setLinkHref('link[rel="apple-touch-icon"]', logo192);
    setLinkHref('link[rel="manifest"]', manifestHref);
  }, [favicon, logo192, manifestHref]);

  return null;
}

// Avoid requirement to have props which are required in app providers anyway
type AppConfigProviderOverrides = Omit<
  AppConfigProviderProps,
  "children" | "retryOptions"
>;

export interface AppProvidersProps {
  children: ReactNode;
  appConfigRetryOptions?: AppConfigRetryOptions;
  appConfigProviderProps?: Partial<AppConfigProviderOverrides>;
}

// Component to sync server defaults to preferences when AppConfig loads
function ServerDefaultsSync() {
  const { config } = useAppConfig();
  const { updateServerDefaults } = usePreferences();

  useEffect(() => {
    if (config) {
      const serverDefaults = {
        hideUnavailableTools: config.defaultHideUnavailableTools ?? false,
        hideUnavailableConversions:
          config.defaultHideUnavailableConversions ?? false,
      };
      updateServerDefaults(serverDefaults);
    }
  }, [config, updateServerDefaults]);

  return null;
}

/**
 * Core application providers
 * Contains all providers needed for the core
 */
export function AppProviders({
  children,
  appConfigRetryOptions,
  appConfigProviderProps,
}: AppProvidersProps) {
  return (
    <PreferencesProvider>
      <RainbowThemeProvider>
        <ErrorBoundary>
          <BannerProvider>
            <AppConfigProvider
              retryOptions={appConfigRetryOptions}
              {...appConfigProviderProps}
            >
              <ScarfTrackingInitializer />
              <AppConfigLoader />
              <ServerDefaultsSync />
              <FileContextProvider
                enableUrlSync={true}
                enablePersistence={true}
              >
                <AppInitializer />
                <EmbedderBridge />
                <BrandingAssetManager />
                <ToolRegistryProvider>
                  <NavigationProvider>
                    <FilesModalProvider>
                      <ToolWorkflowProvider>
                        <HotkeyProvider>
                          <SidebarProvider>
                            <ViewerProvider>
                              <PageEditorProvider>
                                <SignatureProvider>
                                  <RedactionProvider>
                                    <FormFillProvider>
                                      <AnnotationProvider>
                                        <RightRailProvider>
                                          <TourOrchestrationProvider>
                                            <AdminTourOrchestrationProvider>
                                              {children}
                                            </AdminTourOrchestrationProvider>
                                          </TourOrchestrationProvider>
                                        </RightRailProvider>
                                      </AnnotationProvider>
                                    </FormFillProvider>
                                  </RedactionProvider>
                                </SignatureProvider>
                              </PageEditorProvider>
                            </ViewerProvider>
                          </SidebarProvider>
                        </HotkeyProvider>
                      </ToolWorkflowProvider>
                    </FilesModalProvider>
                  </NavigationProvider>
                </ToolRegistryProvider>
              </FileContextProvider>
            </AppConfigProvider>
          </BannerProvider>
        </ErrorBoundary>
      </RainbowThemeProvider>
    </PreferencesProvider>
  );
}
