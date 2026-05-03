import React, { useEffect, useRef, useState } from "react";
import { FileInput, Text, Stack, Checkbox, Button, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { PrivateContent } from "@app/components/shared/PrivateContent";
import { removeWhiteBackground } from "@app/utils/imageTransparency";
import { alert } from "@app/components/toast";

interface ImageUploaderProps {
  onImageChange: (file: File | null) => void;
  disabled?: boolean;
  label?: string;
  placeholder?: string;
  hint?: string;
  allowBackgroundRemoval?: boolean;
  onProcessedImageData?: (dataUrl: string | null) => void;
}

export const ImageUploader: React.FC<ImageUploaderProps> = ({
  onImageChange,
  disabled = false,
  label,
  placeholder,
  hint,
  allowBackgroundRemoval = false,
  onProcessedImageData,
}) => {
  const { t } = useTranslation();
  const [removeBackground, setRemoveBackground] = useState(false);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [originalImageData, setOriginalImageData] = useState<string | null>(
    null,
  );
  const [isProcessing, setIsProcessing] = useState(false);

  // BIK fork: Drive-Picker-Bridge. Wenn wir in einem Iframe laufen
  // (window !== window.parent), bieten wir einen "Aus Drive einfügen"-
  // Button an. Klick → postMessage("stirling:request-drive-pick") an
  // Parent → Parent öffnet Drive-Picker → Parent schickt
  // "stirling:drive-asset" mit bytes/filename/mimeType zurück → wir
  // bauen ein File draus und kippen es in die Standard-handleImageChange-
  // Pipeline. Standalone (kein Embed) bleibt der Button unsichtbar.
  const isEmbedded =
    typeof window !== "undefined" && window !== window.parent;
  const requestIdRef = useRef<string | null>(null);
  const [drivePicking, setDrivePicking] = useState(false);

  const processImage = async (
    imageSource: File | string,
    shouldRemoveBackground: boolean,
  ): Promise<void> => {
    if (shouldRemoveBackground && allowBackgroundRemoval) {
      setIsProcessing(true);
      try {
        const transparentImageDataUrl = await removeWhiteBackground(
          imageSource,
          {
            autoDetectCorner: true,
            tolerance: 15,
          },
        );
        onProcessedImageData?.(transparentImageDataUrl);
      } catch (error) {
        console.error("Error removing background:", error);
        alert({
          title: t(
            "sign.image.backgroundRemovalFailedTitle",
            "Background removal failed",
          ),
          body: t(
            "sign.image.backgroundRemovalFailedMessage",
            "Could not remove the background from the image. Using original image instead.",
          ),
          alertType: "error",
        });
        onProcessedImageData?.(null);
      } finally {
        setIsProcessing(false);
      }
    } else {
      // When background removal is disabled, return the original image data
      if (typeof imageSource === "string") {
        onProcessedImageData?.(imageSource);
      } else {
        // Convert File to data URL if needed
        const reader = new FileReader();
        reader.onload = (e) => {
          onProcessedImageData?.(e.target?.result as string);
        };
        reader.readAsDataURL(imageSource);
      }
    }
  };

  const handleImageChange = async (file: File | null) => {
    if (file && !disabled) {
      try {
        // Validate that it's actually an image file or SVG
        if (
          !file.type.startsWith("image/") &&
          !file.name.toLowerCase().endsWith(".svg")
        ) {
          console.error("Selected file is not an image or SVG");
          return;
        }

        setCurrentFile(file);
        onImageChange(file);

        let dataUrlToProcess: string;

        // Check if file is SVG
        const isSvg =
          file.type === "image/svg+xml" ||
          file.name.toLowerCase().endsWith(".svg");

        if (isSvg) {
          // For SVG, convert to PNG so it can be embedded in PDF
          dataUrlToProcess = await convertSvgToPng(file);
        } else {
          // For other images, read as data URL directly
          dataUrlToProcess = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
        }

        setOriginalImageData(dataUrlToProcess);
        await processImage(dataUrlToProcess, removeBackground);
      } catch (error) {
        console.error("Error processing image file:", error);
      }
    } else if (!file) {
      // Clear image data when no file is selected
      setCurrentFile(null);
      setOriginalImageData(null);
      onImageChange(null);
      onProcessedImageData?.(null);
    }
  };

  // Helper function to convert SVG to PNG
  const convertSvgToPng = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const svgText = e.target?.result as string;

          // Parse SVG to get dimensions
          const parser = new DOMParser();
          const svgDoc = parser.parseFromString(svgText, "image/svg+xml");
          const svgElement = svgDoc.documentElement;

          // Get SVG dimensions
          let width = 800; // Default width
          let height = 600; // Default height

          if (
            svgElement.hasAttribute("width") &&
            svgElement.hasAttribute("height")
          ) {
            width = parseFloat(svgElement.getAttribute("width") || "800");
            height = parseFloat(svgElement.getAttribute("height") || "600");
          } else if (svgElement.hasAttribute("viewBox")) {
            const viewBox = svgElement.getAttribute("viewBox")?.split(/\s+|,/);
            if (viewBox && viewBox.length === 4) {
              width = parseFloat(viewBox[2]);
              height = parseFloat(viewBox[3]);
            }
          }

          // Ensure reasonable dimensions
          if (
            width === 0 ||
            height === 0 ||
            !isFinite(width) ||
            !isFinite(height)
          ) {
            width = 800;
            height = 600;
          }

          // Scale large SVGs down
          const maxDimension = 2048;
          if (width > maxDimension || height > maxDimension) {
            const scale = Math.min(maxDimension / width, maxDimension / height);
            width *= scale;
            height *= scale;
          }

          console.log("Converting SVG to PNG:", { width, height });

          // Create an image element to render SVG
          const img = new Image();
          const blob = new Blob([svgText], {
            type: "image/svg+xml;charset=utf-8",
          });
          const url = URL.createObjectURL(blob);

          img.onload = () => {
            try {
              // Use computed dimensions or image natural dimensions
              const finalWidth = img.naturalWidth || img.width || width;
              const finalHeight = img.naturalHeight || img.height || height;

              console.log("Image loaded:", {
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                finalWidth,
                finalHeight,
              });

              // Create canvas to convert to PNG
              const canvas = document.createElement("canvas");
              canvas.width = finalWidth;
              canvas.height = finalHeight;

              const ctx = canvas.getContext("2d");
              if (!ctx) {
                URL.revokeObjectURL(url);
                reject(new Error("Failed to get canvas context"));
                return;
              }

              // Fill with white background (optional, for transparency support)
              ctx.fillStyle = "white";
              ctx.fillRect(0, 0, finalWidth, finalHeight);

              // Draw SVG
              ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
              URL.revokeObjectURL(url);

              // Convert canvas to PNG data URL
              const pngDataUrl = canvas.toDataURL("image/png");
              console.log("SVG converted to PNG successfully");
              resolve(pngDataUrl);
            } catch (error) {
              URL.revokeObjectURL(url);
              console.error("Error during canvas rendering:", error);
              reject(error);
            }
          };

          img.onerror = (error) => {
            URL.revokeObjectURL(url);
            console.error("Failed to load SVG image:", error);
            reject(new Error("Failed to load SVG image"));
          };

          img.src = url;
        } catch (error) {
          console.error("Error parsing SVG:", error);
          reject(error);
        }
      };

      reader.onerror = () => {
        console.error("Error reading file:", reader.error);
        reject(reader.error);
      };
      reader.readAsText(file);
    });
  };

  const handleBackgroundRemovalChange = async (checked: boolean) => {
    if (isProcessing) return; // Prevent race conditions
    setRemoveBackground(checked);
    if (originalImageData) {
      await processImage(originalImageData, checked);
    }
  };

  // Hört auf die Antwort des Embedders. Filtert per requestId, damit
  // konkurrente ImageUploader-Instanzen sich nicht gegenseitig die
  // Bytes klauen.
  useEffect(() => {
    if (!isEmbedded) return;
    function onParentMessage(ev: MessageEvent) {
      const data = ev.data as
        | {
            type?: string;
            requestId?: string;
            bytes?: ArrayBuffer;
            filename?: string;
            mimeType?: string;
            error?: string;
          }
        | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type !== "stirling:drive-asset") return;
      // eslint-disable-next-line no-console
      console.log("[stirling drive-pick] received drive-asset:", {
        requestId: data.requestId,
        expectedId: requestIdRef.current,
        hasBytes: !!data.bytes,
        bytesType:
          data.bytes && typeof data.bytes === "object"
            ? (data.bytes as ArrayBuffer).byteLength + " bytes"
            : typeof data.bytes,
        filename: data.filename,
        mimeType: data.mimeType,
        error: data.error,
      });
      if (!requestIdRef.current || data.requestId !== requestIdRef.current) {
        // eslint-disable-next-line no-console
        console.warn(
          "[stirling drive-pick] requestId mismatch — dropping message",
        );
        return;
      }
      requestIdRef.current = null;
      setDrivePicking(false);

      if (data.error) {
        // eslint-disable-next-line no-console
        console.warn("[stirling drive-pick] embedder error:", data.error);
        return;
      }
      if (!data.bytes || !(data.bytes instanceof ArrayBuffer)) {
        // eslint-disable-next-line no-console
        console.warn("[stirling drive-pick] no/invalid bytes payload");
        return;
      }
      try {
        const file = new File(
          [data.bytes],
          data.filename || "drive-image.png",
          { type: data.mimeType || "image/png" },
        );
        // eslint-disable-next-line no-console
        console.log(
          "[stirling drive-pick] feeding file into handleImageChange:",
          { name: file.name, type: file.type, size: file.size },
        );
        void handleImageChange(file);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[stirling drive-pick] file build failed:", e);
      }
    }
    window.addEventListener("message", onParentMessage);
    return () => window.removeEventListener("message", onParentMessage);
  }, [isEmbedded]);

  const onPickFromDrive = () => {
    if (!isEmbedded || disabled || drivePicking) return;
    const id = `drive-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = id;
    setDrivePicking(true);
    // eslint-disable-next-line no-console
    console.log("[stirling drive-pick] sending request to parent:", id);
    try {
      window.parent.postMessage(
        {
          type: "stirling:request-drive-pick",
          requestId: id,
          mimeFilter: "image/*",
        },
        "*",
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[stirling drive-pick] postMessage failed:", e);
      requestIdRef.current = null;
      setDrivePicking(false);
    }
  };

  return (
    <Stack gap="sm">
      <PrivateContent>
        <FileInput
          label={label}
          placeholder={
            placeholder || t("sign.image.placeholder", "Select image file")
          }
          accept="image/*,.svg"
          value={currentFile}
          onChange={handleImageChange}
          disabled={disabled || isProcessing}
          clearable
        />
      </PrivateContent>
      {isEmbedded && (
        <Group gap="xs">
          <Button
            size="xs"
            variant="light"
            color="violet"
            onClick={onPickFromDrive}
            loading={drivePicking}
            disabled={disabled || isProcessing}
          >
            {drivePicking
              ? t("embed.drive.picking", "Drive wird geöffnet…")
              : t("embed.drive.pickImage", "Aus Drive einfügen")}
          </Button>
        </Group>
      )}
      {allowBackgroundRemoval && (
        <Checkbox
          label={t(
            "sign.image.removeBackground",
            "Remove white background (make transparent)",
          )}
          checked={removeBackground}
          onChange={(event) =>
            handleBackgroundRemovalChange(event.currentTarget.checked)
          }
          disabled={disabled || !currentFile || isProcessing}
        />
      )}
      {hint && (
        <Text size="sm" c="dimmed">
          {hint}
        </Text>
      )}
      {isProcessing && (
        <Text size="sm" c="dimmed">
          {t("sign.image.processing", "Processing image...")}
        </Text>
      )}
    </Stack>
  );
};
