"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Camera, Check, LoaderCircle, MapPin, MapPinOff, RotateCcw } from "lucide-react";
import { PHOTO_VERIFICATION_DEFAULTS } from "@pm-buddy/domain";
import { photoCaptureTicketResponseSchema } from "@pm-buddy/validation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { liveRequest } from "@/lib/live-api";
import { usePhotoProblem } from "./site-photo-upload";

/** A photo taken on the camera screen with the fields the server needs to verify it. */
export type CapturedPhoto = { file: File; fields: Record<string, string> };
type Fix = { lat: number; lng: number; accuracyM: number; at: number };
type Shot = { file: File; url: string; capturedAt: string; fix: Fix | null; ticketId: string };

/** A ticket older than this is replaced at the shutter, so the upload stays inside its window. */
const REFRESH_AFTER_MS = (PHOTO_VERIFICATION_DEFAULTS.captureWindowMinutes / 3) * 60_000;
/** A position older than this is not sent with the photo. */
const FIX_MAX_AGE_MS = 2 * 60_000;

class CameraUnavailable extends Error {}

/** Asks the server to record that the camera screen opened for the site. */
async function openCaptureTicket(projectId: string, siteId: string) {
  const { ticket } = await liveRequest(
    `/projects/${projectId}/photos/capture-tickets`,
    photoCaptureTicketResponseSchema,
    { method: "POST", body: { siteId } },
  );
  return { id: ticket.id, siteId: ticket.siteId, openedAt: Date.now() };
}

/** The stream and the video element can arrive in either order; whichever is last joins them. */
function attachStream(element: HTMLVideoElement | null, media: MediaStream | null) {
  if (!element || !media || element.srcObject === media) return;
  element.srcObject = media;
  void element.play().catch(() => undefined);
}

/**
 * PM-Buddy's camera screen (D6.1, THREAT_MODEL A-13). Opening it asks the server for a capture
 * ticket, so the photo's time is bounded by the server clock; the shutter grabs a frame from the
 * live camera (never a gallery file) with the phone's latest GPS fix and its accuracy. Only photos
 * taken here can be verified. A browser cannot attest the device, so a verified photo is strong
 * evidence for review rather than proof.
 */
export function CameraCapture({
  projectId,
  siteId,
  open,
  onOpenChange,
  onCaptured,
}: {
  projectId: string;
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Uploads the photo; throw to keep the camera open with the error shown. */
  onCaptured: (photo: CapturedPhoto) => Promise<void>;
}) {
  const t = useTranslations("photoCapture");
  const problem = usePhotoProblem();
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const ticket = useRef<{ id: string; siteId: string; openedAt: number } | null>(null);
  const fix = useRef<Fix | null>(null);
  const [phase, setPhase] = useState<"starting" | "ready" | "preview" | "uploading" | "failed">(
    "starting",
  );
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<
    { state: "waiting" } | { state: "off" } | { state: "found"; accuracyM: number }
  >({ state: "waiting" });
  const [shot, setShot] = useState<Shot | null>(null);

  const failed = useEffectEvent((caught: unknown) => {
    setPhase("failed");
    setError(
      caught instanceof CameraUnavailable || caught instanceof DOMException
        ? t("cameraUnavailable")
        : problem(caught),
    );
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let watch: number | null = null;
    ticket.current = null;
    fix.current = null;
    if ("geolocation" in navigator)
      watch = navigator.geolocation.watchPosition(
        (position) => {
          fix.current = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: position.coords.accuracy,
            at: Date.now(),
          };
          setLocation({ state: "found", accuracyM: position.coords.accuracy });
        },
        () => {
          if (!fix.current) setLocation({ state: "off" });
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
      );
    else queueMicrotask(() => setLocation({ state: "off" }));
    void (async () => {
      try {
        const opened = await openCaptureTicket(projectId, siteId);
        // A closed (or reopened) camera must not take this ticket or start the camera.
        if (cancelled) return;
        ticket.current = opened;
        if (!navigator.mediaDevices?.getUserMedia) throw new CameraUnavailable();
        const media = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (cancelled) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        // The shutter is enabled once the video shows frames (onLoadedData).
        attachStream(video.current, media);
      } catch (caught) {
        if (!cancelled) failed(caught);
      }
    })();
    return () => {
      cancelled = true;
      if (watch !== null) navigator.geolocation.clearWatch(watch);
      for (const track of stream.current?.getTracks() ?? []) track.stop();
      stream.current = null;
    };
  }, [open, projectId, siteId]);

  function close(next: boolean) {
    if (next) return onOpenChange(true);
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setError(null);
    setPhase("starting");
    setLocation({ state: "waiting" });
    onOpenChange(false);
  }

  async function shutter() {
    const element = video.current;
    if (!element?.videoWidth) return;
    setError(null);
    try {
      if (
        !ticket.current ||
        ticket.current.siteId !== siteId ||
        Date.now() - ticket.current.openedAt > REFRESH_AFTER_MS
      )
        ticket.current = await openCaptureTicket(projectId, siteId);
    } catch (caught) {
      setError(problem(caught));
      return;
    }
    const capturedAt = new Date().toISOString();
    const position =
      fix.current && Date.now() - fix.current.at <= FIX_MAX_AGE_MS ? fix.current : null;
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob || !ticket.current) return setError(t("captureFailed"));
    setShot({
      file: new File([blob], `capture-${capturedAt.replace(/[:.]/g, "-")}.jpg`, {
        type: "image/jpeg",
      }),
      url: URL.createObjectURL(blob),
      capturedAt,
      fix: position,
      ticketId: ticket.current.id,
    });
    setPhase("preview");
  }

  function retake() {
    if (shot) URL.revokeObjectURL(shot.url);
    setShot(null);
    setPhase("ready");
  }

  async function use() {
    if (!shot) return;
    setPhase("uploading");
    setError(null);
    try {
      await onCaptured({
        file: shot.file,
        fields: {
          captureTicketId: shot.ticketId,
          capturedAt: shot.capturedAt,
          ...(shot.fix
            ? {
                latitude: shot.fix.lat.toFixed(6),
                longitude: shot.fix.lng.toFixed(6),
                accuracyM: Math.min(shot.fix.accuracyM, 99_999).toFixed(1),
              }
            : {}),
        },
      });
      // Each ticket is used once: the next photo opens a new one.
      ticket.current = null;
      close(false);
    } catch (caught) {
      setPhase("preview");
      setError(problem(caught));
    }
  }

  const coarse =
    location.state === "found" && location.accuracyM > PHOTO_VERIFICATION_DEFAULTS.maxAccuracyM;
  const warn = location.state === "off" || coarse;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <p
          role="status"
          className={`flex items-start gap-1.5 text-sm ${
            warn ? "text-warning-foreground dark:text-warning" : "text-muted-foreground"
          }`}
        >
          {location.state === "off" ? (
            <MapPinOff className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span>
            {location.state === "waiting"
              ? t("locating")
              : location.state === "off"
                ? t("locationOff")
                : coarse
                  ? t("locationCoarse", { accuracy: Math.round(location.accuracyM) })
                  : t("locationFound", { accuracy: Math.round(location.accuracyM) })}
          </span>
        </p>
        <div className="relative overflow-hidden rounded-md bg-black">
          <video
            ref={(element) => {
              video.current = element;
              attachStream(element, stream.current);
            }}
            muted
            playsInline
            autoPlay
            onLoadedData={() => setPhase((current) => (current === "starting" ? "ready" : current))}
            aria-label={t("viewfinder")}
            className={`aspect-[4/3] w-full object-cover ${shot ? "hidden" : ""}`}
          />
          {shot ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview (blob URL)
            <img src={shot.url} alt={t("preview")} className="aspect-[4/3] w-full object-cover" />
          ) : null}
          {phase === "starting" ? (
            <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white">
              <LoaderCircle className="size-4 animate-spin" aria-hidden /> {t("starting")}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => close(false)}>
            {t("close")}
          </Button>
          {phase === "preview" || phase === "uploading" ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={phase === "uploading"}
                onClick={retake}
              >
                <RotateCcw aria-hidden /> {t("retake")}
              </Button>
              <Button type="button" disabled={phase === "uploading"} onClick={() => void use()}>
                {phase === "uploading" ? (
                  <LoaderCircle className="animate-spin" aria-hidden />
                ) : (
                  <Check aria-hidden />
                )}
                {phase === "uploading" ? t("uploading") : t("use")}
              </Button>
            </div>
          ) : (
            <Button type="button" disabled={phase !== "ready"} onClick={() => void shutter()}>
              <Camera aria-hidden /> {t("shutter")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
