import { createHash, randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import sharp from "sharp";
import request from "supertest";
import type { App } from "supertest/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nairobiDate } from "@pm-buddy/domain";
import {
  auditEventsResponseSchema,
  diaryResponseSchema,
  photoCaptureTicketResponseSchema,
  projectResponseSchema,
  sitePhotoResponseSchema,
  sitePhotosResponseSchema,
  siteResponseSchema,
  tenantCreatedResponseSchema,
  type SitePhoto,
} from "@pm-buddy/validation";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.setup.js";
import { PrismaService } from "../src/infra/prisma.service.js";
import { AuthSecurity } from "../src/modules/identity/auth-security.service.js";
import { TenantDatabase } from "../src/modules/identity/tenant-database.service.js";
import {
  heicPhoto,
  inAppCapture,
  jpegWithExif,
  pattern,
  plainJpeg,
  type PhotoSpec,
} from "./photo-fixtures.js";
import { Browser, notifications, origin } from "./support.js";

/** Metres → degrees near Ruiru (latitude −1.15°). */
const ruiru = { lat: -1.1489, lng: 36.9612 };
const at = (east: number, north: number) => ({
  lat: Math.round((ruiru.lat + north / 111_195) * 1e6) / 1e6,
  lng: Math.round((ruiru.lng + east / 111_173) * 1e6) / 1e6,
});
const plot = { kind: "polygon", vertices: [at(0, 0), at(60, 0), at(60, 45), at(0, 45)] } as const;
const HOUR = 3_600_000;
/** EXIF wall-clock time in Nairobi (UTC+3) for an instant. */
const exifTime = (date: Date) =>
  new Date(date.getTime() + 3 * HOUR)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
    .replace(/-/g, ":");
const taken = (ago: number, place = at(30, 20), extra: PhotoSpec = {}): PhotoSpec => ({
  ...place,
  original: exifTime(new Date(Date.now() - ago)),
  offset: "+03:00",
  make: "TestCam",
  model: "TestCam Field 1",
  ...extra,
});

describe("Geotagged site photos (real runtime role, object storage)", () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let db: TenantDatabase;
  let owner: Browser;
  let ownerB: Browser;
  let agent: Browser;
  let client: Browser;
  let tenantA: string;
  let tenantB: string;
  let projectId: string;
  /** A second project of company A, for near-duplicates across projects. */
  let secondProject: string;
  let secondSite: string;
  let otherProject: string;
  let siteId: string;
  let otherSite: string;
  let notificationSpy: ReturnType<typeof vi.spyOn>;

  const fresh = (browser: Browser) =>
    prisma.session.update({
      where: { id: browser.auth.session.id },
      data: { mfaVerifiedAt: new Date() },
    });
  const cookies = (browser: Browser) =>
    [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const upload = (
    browser: Browser,
    content: Buffer,
    fields: Record<string, string> = { siteId },
    project = projectId,
    fileName = "IMG_0001.jpg",
  ) => {
    const operation = request(app.getHttpServer())
      .post(`/api/v1/projects/${project}/photos`)
      .set("Cookie", cookies(browser))
      .set("Origin", origin)
      .set("X-CSRF-Token", browser.csrf);
    for (const [key, value] of Object.entries(fields)) operation.field(key, value);
    return operation.attach("file", content, fileName);
  };
  const uploaded = async (
    content: Buffer,
    fields?: Record<string, string>,
    { who = agent, project = projectId, fileName = "IMG_0001.jpg" } = {},
  ) => {
    const res = await upload(who, content, fields, project, fileName);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo;
  };
  /** In-app capture fields for the main plot (or another place, project or site). */
  const capture = (
    place: { lat: number; lng: number } | null = at(30, 20),
    extra: Record<string, string> = {},
    who = agent,
    project = projectId,
    site = siteId,
  ) => inAppCapture(who, project, site, place, extra);
  const image = (browser: Browser, photo: SitePhoto, variant: string, project = projectId) =>
    browser.download(`projects/${project}/photos/${photo.id}/${variant}`);
  const code = (res: request.Response) => (res.body as { code?: string }).code;
  const as = (browser: Browser, tenantId: string) => ({
    userId: browser.auth.user.id,
    tenantId,
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication({
      bufferLogs: true,
    });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    db = app.get(TenantDatabase);
    notificationSpy = vi
      .spyOn(app.get(AuthSecurity), "notify")
      .mockImplementation(async (identifier, subject, text) => {
        notifications.set(identifier, [
          ...(notifications.get(identifier) ?? []),
          { subject, text },
        ]);
      });
    [owner, ownerB, agent, client] = [0, 1, 2, 3].map(() => new Browser(app));
    for (const browser of [owner, ownerB]) {
      await browser.register();
      await browser.enroll();
    }
    for (const browser of [agent, client]) await browser.register();
    tenantA = tenantCreatedResponseSchema.parse(
      (await owner.call("post", "tenants", { name: "Photo company A" })).body,
    ).tenant.id;
    tenantB = tenantCreatedResponseSchema.parse(
      (await ownerB.call("post", "tenants", { name: "Photo company B" })).body,
    ).tenant.id;
    projectId = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Photo project" })).body,
    ).project.id;
    secondProject = projectResponseSchema.parse(
      (await owner.call("post", "projects", { name: "Second photo project" })).body,
    ).project.id;
    secondSite = siteResponseSchema.parse(
      (
        await owner.call("post", `projects/${secondProject}/sites`, {
          name: "Second plot",
          geofence: plot,
        })
      ).body,
    ).site.id;
    otherProject = projectResponseSchema.parse(
      (await ownerB.call("post", "projects", { name: "Other company project" })).body,
    ).project.id;
    const site = async (name: string, geofence: object) =>
      siteResponseSchema.parse(
        (await owner.call("post", `projects/${projectId}/sites`, { name, geofence })).body,
      ).site.id;
    siteId = await site("Main plot", plot);
    otherSite = await site("Yard", { kind: "radius", center: at(30, -400), radiusM: 40 });
    for (const [member, role] of [
      [agent, "site_agent"],
      [client, "client"],
    ] as const) {
      await fresh(owner);
      const invited = await owner.call("post", "tenants/current/invitations", {
        identifier: member.identifier,
        role,
        projectIds: [projectId, secondProject],
      });
      expect(invited.status).toBe(201);
      const token = notifications
        .get(member.identifier)
        ?.at(-1)
        ?.text.match(/Invitation token: ([A-Za-z0-9_-]+)/)?.[1];
      expect((await member.call("post", "tenants/invitations/accept", { token })).status).toBe(200);
      expect((await member.call("post", `tenants/${tenantA}/select`, {})).status).toBe(200);
    }
  });

  afterAll(async () => {
    notificationSpy?.mockRestore();
    await app?.close();
  });

  it("documents the photo operations", async () => {
    const spec = await request(app.getHttpServer()).get("/api/docs/openapi.json").expect(200);
    const operations = Object.values(
      (spec.body as { paths: Record<string, Record<string, { operationId?: string }>> }).paths,
    ).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
    for (const id of [
      "listSitePhotos",
      "openSitePhotoCapture",
      "uploadSitePhoto",
      "getSitePhotoThumbnail",
      "getSitePhotoOriginal",
    ])
      expect(operations).toContain(id);
  });

  it("verifies an in-app capture inside the site and stores the original and a clean thumbnail", async () => {
    const content = await plainJpeg(undefined, 85, 1600, 1200);
    const fields = await capture(at(30, 20), { caption: "  Columns cast  " });
    const photo = await uploaded(content, fields);
    expect(photo).toMatchObject({
      siteId,
      diaryId: null,
      caption: "Columns cast",
      contentType: "image/jpeg",
      captureMethod: "in_app",
      capturedAt: fields["capturedAt"],
      timeSource: "device",
      location: { accuracyM: 8 },
      camera: null,
      width: 1600,
      height: 1200,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      geofenceVersion: 1,
      checks: {
        location: "inside",
        time: "ok",
        distanceM: null,
        similarity: "unique",
        similarTo: null,
      },
      verified: true,
      scanStatus: "not_scanned",
      uploadedBy: { id: agent.auth.user.id },
    });
    expect(photo.location!.lat).toBeCloseTo(at(30, 20).lat, 5);

    const original = await image(agent, photo, "original");
    expect(original.status).toBe(200);
    expect(original.headers["content-type"]).toBe("image/jpeg");
    expect(original.headers["x-content-type-options"]).toBe("nosniff");
    expect(original.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.compare(original.body as Buffer, content)).toBe(0);
    const thumbnail = await image(owner, photo, "thumbnail");
    expect(thumbnail.status).toBe(200);
    const meta = await sharp(thumbnail.body as Buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(960);
    expect(meta.exif).toBeUndefined();
  });

  it("never verifies an imported file, though its EXIF is checked for review", async () => {
    const imported = await uploaded(await jpegWithExif(taken(HOUR)));
    expect(imported).toMatchObject({
      captureMethod: "imported",
      timeSource: "offset",
      camera: "TestCam Field 1",
      location: { accuracyM: null },
      geofenceVersion: 1,
      checks: { location: "inside", time: "ok", similarity: "unique", similarTo: null },
      verified: false,
    });
    const outside = await uploaded(await jpegWithExif(taken(HOUR, at(30, 220))));
    expect(outside).toMatchObject({ verified: false, checks: { location: "outside", time: "ok" } });
    expect(outside.checks.distanceM).toBeGreaterThan(170);
    expect(outside.checks.distanceM).toBeLessThan(180);

    const bare = await uploaded(await plainJpeg());
    expect(bare).toMatchObject({
      verified: false,
      location: null,
      capturedAt: null,
      timeSource: null,
      geofenceVersion: null,
      checks: { location: "missing", time: "missing", distanceM: null },
    });
    expect((await uploaded(await jpegWithExif(taken(4 * 24 * HOUR)))).checks.time).toBe("stale");
    expect((await uploaded(await jpegWithExif(taken(-HOUR)))).checks.time).toBe("future");
    const assumed = await uploaded(
      await jpegWithExif({ ...taken(HOUR), offset: undefined, gpsDate: undefined }),
    );
    expect(assumed).toMatchObject({
      timeSource: "assumed_nairobi",
      checks: { time: "ok" },
      verified: false,
    });
  });

  it("records why an in-app capture is not verified", async () => {
    const outside = await uploaded(await plainJpeg(), await capture(at(30, 220)));
    expect(outside).toMatchObject({ verified: false, checks: { location: "outside", time: "ok" } });
    expect(outside.checks.distanceM).toBeGreaterThan(170);
    const coarse = await uploaded(
      await plainJpeg(),
      await capture(at(30, 20), { accuracyM: "120" }),
    );
    expect(coarse).toMatchObject({
      location: { accuracyM: 120 },
      geofenceVersion: null,
      checks: { location: "low_accuracy", time: "ok" },
      verified: false,
    });
    const nowhere = await uploaded(await plainJpeg(), await capture(null));
    expect(nowhere).toMatchObject({
      location: null,
      checks: { location: "missing", time: "ok" },
      verified: false,
    });
    // The shutter time must fall after the camera opened (10 minutes' clock allowance) …
    const before = await capture(at(30, 20));
    before["capturedAt"] = new Date(Date.now() - 20 * 60_000).toISOString();
    expect(await uploaded(await plainJpeg(), before)).toMatchObject({
      checks: { time: "outside_window" },
      verified: false,
    });
    // … and not ahead of the upload.
    const ahead = await capture(at(30, 20));
    ahead["capturedAt"] = new Date(Date.now() + HOUR).toISOString();
    expect((await uploaded(await plainJpeg(), ahead)).checks.time).toBe("future");
  });

  it("accepts an iPhone HEIC, keeps it as uploaded, reads its EXIF and makes a JPEG preview", async () => {
    const content = heicPhoto();
    const photo = await uploaded(content, { siteId }, { fileName: "IMG_0002.HEIC" });
    expect(photo).toMatchObject({
      contentType: "image/heic",
      captureMethod: "imported",
      camera: "Apple iPhone 15",
      capturedAt: "2026-01-15T06:15:00.000Z",
      timeSource: "offset",
      location: { lat: -1.148719, lng: 36.961469, accuracyM: null },
      width: 160,
      height: 120,
      sha256: createHash("sha256").update(content).digest("hex"),
      geofenceVersion: 1,
      checks: { location: "inside", time: "stale", similarity: "unique" },
      verified: false,
    });
    const original = await image(agent, photo, "original");
    expect(original.headers["content-type"]).toBe("image/heic");
    expect(original.headers["content-disposition"]).toContain(".heic");
    expect(Buffer.compare(original.body as Buffer, content)).toBe(0);
    const thumbnail = await image(agent, photo, "thumbnail");
    expect(thumbnail.headers["content-type"]).toBe("image/jpeg");
    const meta = await sharp(thumbnail.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual([
      "jpeg",
      160,
      120,
      undefined,
    ]);

    expect(code(await upload(agent, content.subarray(0, 700)))).toBe("invalid-image");
    const avif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } })
      .avif()
      .toBuffer();
    expect((await upload(agent, avif, { siteId }, projectId, "photo.heic")).status).toBe(415);
  });

  it("does not verify a picture that looks like one from another project or day; bursts are fine", async () => {
    const seed = pattern();
    const first = await uploaded(await plainJpeg(seed, 90, 640, 480), await capture());
    expect(first).toMatchObject({ verified: true, checks: { similarity: "unique" } });
    const burst = await uploaded(await plainJpeg(seed, 55, 640, 480), await capture());
    expect(burst).toMatchObject({
      verified: true,
      checks: { similarity: "unique", similarTo: null },
    });
    const elsewhere = await uploaded(
      await plainJpeg(seed, 70, 800, 600),
      await capture(at(30, 20), {}, agent, secondProject, secondSite),
      { project: secondProject },
    );
    expect(elsewhere).toMatchObject({
      verified: false,
      checks: { similarity: "similar", similarTo: { photoId: null, otherProject: true } },
    });
    expect(elsewhere.checks.similarTo!.distance).toBeLessThanOrEqual(6);

    // An imported photo of this project, recorded again with yesterday's upload time.
    const yesterday = pattern();
    const recent = await uploaded(await jpegWithExif({ ...taken(HOUR), pattern: yesterday }));
    const earlierId = randomUUID();
    const row = await db.run(as(agent, tenantA), (tx) =>
      tx.sitePhoto.findUniqueOrThrow({ where: { id: recent.id } }),
    );
    await db.run(as(agent, tenantA), (tx) =>
      tx.sitePhoto.create({
        data: {
          ...row,
          id: earlierId,
          fileSha256: "c".repeat(64),
          objectKey: `tenants/${tenantA}/projects/${projectId}/photos/${earlierId}/original.jpg`,
          thumbnailKey: `tenants/${tenantA}/projects/${projectId}/photos/${earlierId}/thumbnail.jpg`,
          uploadedAt: new Date(Date.now() - 24 * HOUR),
        },
      }),
    );
    const reused = await uploaded(await plainJpeg(yesterday, 75, 64, 48), await capture());
    expect(reused).toMatchObject({
      verified: false,
      checks: {
        location: "inside",
        time: "ok",
        similarity: "similar",
        similarTo: { photoId: earlierId, otherProject: false },
      },
    });
    const listed = sitePhotosResponseSchema
      .parse((await agent.call("get", `projects/${projectId}/photos?limit=60`)).body)
      .photos.find((photo) => photo.id === reused.id);
    expect(listed?.checks.similarTo?.photoId).toBe(earlierId);
    // A different picture is unique.
    expect((await uploaded(await plainJpeg(), await capture())).checks.similarity).toBe("unique");
  });

  it("uses each capture ticket once, by whoever opened it, for its own site", async () => {
    const fields = await capture();
    await uploaded(await plainJpeg(), fields);
    const reused = await upload(agent, await plainJpeg(), fields);
    expect([reused.status, code(reused)]).toEqual([409, "capture-ticket-used"]);
    await fresh(owner);
    const ownersTicket = await capture(at(30, 20), {}, owner);
    const stolen = await upload(agent, await plainJpeg(), ownersTicket);
    expect([stolen.status, code(stolen)]).toEqual([422, "capture-ticket-invalid"]);
    const wrongSite = await upload(agent, await plainJpeg(), {
      ...(await capture()),
      siteId: otherSite,
    });
    expect(code(wrongSite)).toBe("capture-ticket-invalid");
    const forged = await upload(agent, await plainJpeg(), {
      ...(await capture()),
      captureTicketId: randomUUID(),
    });
    expect(code(forged)).toBe("capture-ticket-invalid");
    // Capture details come only with a ticket, and a ticket needs the shutter time.
    const { captureTicketId: _ticket, ...untethered } = await capture();
    expect((await upload(agent, await plainJpeg(), untethered)).status).toBe(400);
    const { capturedAt: _time, ...timeless } = await capture();
    expect((await upload(agent, await plainJpeg(), timeless)).status).toBe(400);

    const open = (browser: Browser, body: object, project = projectId) =>
      browser.call("post", `projects/${project}/photos/capture-tickets`, body);
    const opened = await open(agent, { siteId });
    expect(opened.status).toBe(201);
    const { ticket } = photoCaptureTicketResponseSchema.parse(opened.body);
    expect(Date.parse(ticket.useBy) - Date.parse(ticket.issuedAt)).toBe(30 * 60_000);
    expect(Math.abs(Date.parse(ticket.issuedAt) - Date.now())).toBeLessThan(60_000);
    expect((await open(client, { siteId })).status).toBe(403);
    expect((await open(ownerB, { siteId })).status).toBe(404);
    expect((await open(agent, { siteId: secondSite })).status).toBe(404);
    expect((await open(agent, { siteId: "nope" })).status).toBe(400);

    // The database sets a ticket's owner and time, and keeps it append-only.
    const stored = await db.run(as(agent, tenantA), (tx) =>
      tx.photoCaptureTicket.create({
        data: {
          id: randomUUID(),
          tenantId: tenantA,
          projectId,
          siteId,
          issuedTo: agent.auth.user.id,
          issuedAt: new Date("2020-01-01T00:00:00Z"),
        },
      }),
    );
    expect(Math.abs(stored.issuedAt.getTime() - Date.now())).toBeLessThan(60_000);
    await expect(
      db.run(as(agent, tenantA), (tx) =>
        tx.photoCaptureTicket.create({
          data: { ...stored, id: randomUUID(), issuedTo: owner.auth.user.id },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(agent, tenantA), (tx) =>
        tx.photoCaptureTicket.update({
          where: { id: stored.id },
          data: { issuedAt: new Date("2020-01-01T00:00:00Z") },
        }),
      ),
    ).rejects.toThrow();
  });

  it("checks against the geofence version in force when the photo was taken", async () => {
    const sites = await owner.call("get", `projects/${projectId}/sites`);
    const current = (
      sites.body as { sites: { id: string; geofence: { version: number } }[] }
    ).sites.find((value) => value.id === otherSite)!;
    const before = await jpegWithExif(taken(2 * HOUR, at(30, -400)));
    const changed = await owner.call("put", `projects/${projectId}/sites/${otherSite}/geofence`, {
      geofence: { kind: "radius", center: at(330, -400), radiusM: 40 },
      currentVersion: current.geofence.version,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const early = await uploaded(before, { siteId: otherSite });
    expect(early).toMatchObject({ geofenceVersion: 1, checks: { location: "inside" } });
    const late = await uploaded(
      await plainJpeg(),
      await capture(at(30, -400), {}, agent, projectId, otherSite),
    );
    expect(late).toMatchObject({
      verified: false,
      geofenceVersion: 2,
      checks: { location: "outside" },
    });
    const moved = await uploaded(
      await plainJpeg(),
      await capture(at(330, -400), {}, agent, projectId, otherSite),
    );
    expect(moved).toMatchObject({ verified: true, geofenceVersion: 2 });
  });

  it("attaches photos only to draft diaries of the same site and checks the diary date", async () => {
    const create = async (date: string) =>
      diaryResponseSchema.parse(
        (
          await agent.call("post", `projects/${projectId}/diaries`, {
            siteId,
            date,
            workPerformed: "Slab works",
            weather: null,
            delays: null,
            workforceCount: 8,
          })
        ).body,
      ).diary;
    const today = await create(nairobiDate());
    const linked = await uploaded(
      await plainJpeg(),
      await capture(at(30, 20), { diaryId: today.id }),
    );
    expect(linked).toMatchObject({ diaryId: today.id, verified: true });
    const earlier = await create("2026-01-15");
    const mismatch = await uploaded(
      await plainJpeg(),
      await capture(at(30, 20), { diaryId: earlier.id }),
    );
    expect(mismatch).toMatchObject({ verified: false, checks: { time: "diary_mismatch" } });
    const wrongSite = await upload(agent, await jpegWithExif(taken(HOUR)), {
      siteId: otherSite,
      diaryId: today.id,
    });
    expect(wrongSite.status).toBe(404);
    const submitted = await agent.call(
      "post",
      `projects/${projectId}/diaries/${today.id}/actions`,
      {
        action: "submit",
        version: today.version,
      },
    );
    expect(submitted.status).toBe(200);
    const late = await upload(agent, await jpegWithExif(taken(HOUR)), {
      siteId,
      diaryId: today.id,
    });
    expect(code(late)).toBe("diary-not-draft");
    const filtered = sitePhotosResponseSchema.parse(
      (await agent.call("get", `projects/${projectId}/photos?diaryId=${today.id}`)).body,
    );
    expect(filtered.photos.map((photo) => photo.id)).toEqual([linked.id]);
  });

  it("refuses duplicates, other formats, undecodable, oversized and pixel-bomb uploads", async () => {
    const content = await jpegWithExif(taken(HOUR));
    await uploaded(content);
    const before = await db.run(as(owner, tenantA), (tx) => tx.sitePhoto.count());
    expect(code(await upload(agent, content))).toBe("photo-duplicate");
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    expect((await upload(agent, png, { siteId }, projectId, "photo.jpg")).status).toBe(415);
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);
    expect(code(await upload(agent, corrupt))).toBe("invalid-image");
    const bomb = await sharp({
      create: { width: 8000, height: 7000, channels: 3, background: "#222" },
    })
      .jpeg({ quality: 10 })
      .toBuffer();
    expect(code(await upload(agent, bomb))).toBe("invalid-image");
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1, 0x20);
    content.copy(oversized);
    const tooBig = await upload(agent, oversized);
    expect([tooBig.status, code(tooBig)]).toEqual([413, "payload-too-large"]);
    const missing = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/photos`)
      .set("Cookie", cookies(agent))
      .set("Origin", origin)
      .set("X-CSRF-Token", agent.csrf)
      .field("siteId", siteId);
    expect(code(missing)).toBe("file-required");
    const invalid: Record<string, string>[] = [
      {},
      { siteId: "nope" },
      { siteId, verified: "true" },
    ];
    for (const fields of invalid)
      expect((await upload(agent, await jpegWithExif(taken(HOUR)), fields)).status).toBe(400);
    expect(await db.run(as(owner, tenantA), (tx) => tx.sitePhoto.count())).toBe(before);
  });

  it("enforces permissions, project scope and company isolation", async () => {
    const photo = await uploaded(await jpegWithExif(taken(HOUR)));
    expect((await client.call("get", `projects/${projectId}/photos`)).status).toBe(403);
    expect((await image(client, photo, "thumbnail")).status).toBe(403);
    expect((await upload(client, await jpegWithExif(taken(HOUR)))).status).toBe(403);
    expect((await ownerB.call("get", `projects/${projectId}/photos`)).status).toBe(404);
    expect((await image(ownerB, photo, "original")).status).toBe(404);
    expect((await image(ownerB, photo, "original", otherProject)).status).toBe(404);
    expect((await upload(ownerB, await jpegWithExif(taken(HOUR)))).status).toBe(404);
    expect(
      (await upload(ownerB, await jpegWithExif(taken(HOUR)), { siteId }, otherProject)).status,
    ).toBe(404);
    const unauthenticated = await request(app.getHttpServer()).get(
      `/api/v1/projects/${projectId}/photos/${photo.id}/thumbnail`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(
      await db.run(as(ownerB, tenantB), (tx) => tx.sitePhoto.count({ where: { id: photo.id } })),
    ).toBe(0);
  });

  it("keeps photos append-only and their verification consistent in the database", async () => {
    const photo = await uploaded(await jpegWithExif(taken(HOUR)));
    const inApp = await uploaded(await plainJpeg(), await capture());
    await expect(
      db.run(as(agent, tenantA), (tx) =>
        tx.sitePhoto.update({ where: { id: photo.id }, data: { caption: "Tampered" } }),
      ),
    ).rejects.toThrow();
    await expect(
      db.run(as(agent, tenantA), (tx) => tx.sitePhoto.delete({ where: { id: photo.id } })),
    ).rejects.toThrow();
    const row = await db.run(as(agent, tenantA), (tx) =>
      tx.sitePhoto.findUniqueOrThrow({ where: { id: photo.id } }),
    );
    const id = randomUUID();
    const base = {
      ...row,
      id,
      fileSha256: "b".repeat(64),
      objectKey: `tenants/${tenantA}/projects/${projectId}/photos/${id}/original.jpg`,
      thumbnailKey: `tenants/${tenantA}/projects/${projectId}/photos/${id}/thumbnail.jpg`,
    };
    const inAppRow = await db.run(as(agent, tenantA), (tx) =>
      tx.sitePhoto.findUniqueOrThrow({ where: { id: inApp.id } }),
    );
    for (const data of [
      { ...base, locationCheck: "outside", verified: true },
      // An imported photo is never verified; only an in-app one has a ticket and device time.
      { ...base, verified: true },
      { ...base, captureMethod: "in_app" },
      { ...base, timeSource: "device" },
      { ...base, locationAccuracyM: 5 },
      // Every new photo is checked against earlier ones, and names the one it resembles.
      { ...base, similarityCheck: "not_checked", perceptualHash: null },
      { ...base, similarityCheck: "similar" },
      { ...base, similarPhotoId: photo.id, similarProjectId: projectId, similarityDistance: 1 },
      { ...base, contentType: "image/heic" },
      { ...base, contentType: "image/png" },
      // A capture ticket is used once.
      {
        ...inAppRow,
        id,
        fileSha256: base.fileSha256,
        objectKey: base.objectKey,
        thumbnailKey: base.thumbnailKey,
      },
      { ...base, objectKey: `tenants/${tenantB}/projects/${projectId}/photos/${id}/original.jpg` },
      { ...base, uploadedBy: owner.auth.user.id },
      { ...base, tenantId: tenantB },
      { ...base, siteId: randomUUID() },
    ])
      await expect(
        db.run(as(agent, tenantA), (tx) => tx.sitePhoto.create({ data })),
      ).rejects.toThrow();
    expect(
      await db.run(as(agent, tenantA), (tx) => tx.sitePhoto.create({ data: base })),
    ).toMatchObject({ id });
    const heicId = randomUUID();
    expect(
      await db.run(as(agent, tenantA), (tx) =>
        tx.sitePhoto.create({
          data: {
            ...base,
            id: heicId,
            fileSha256: "d".repeat(64),
            contentType: "image/heic",
            objectKey: `tenants/${tenantA}/projects/${projectId}/photos/${heicId}/original.heic`,
            thumbnailKey: `tenants/${tenantA}/projects/${projectId}/photos/${heicId}/thumbnail.jpg`,
          },
        }),
      ),
    ).toMatchObject({ contentType: "image/heic" });
  });

  it("paginates and audits without coordinates or captions", async () => {
    const first = sitePhotosResponseSchema.parse(
      (await agent.call("get", `projects/${projectId}/photos?limit=2`)).body,
    );
    expect(first.photos).toHaveLength(2);
    const second = sitePhotosResponseSchema.parse(
      (await agent.call("get", `projects/${projectId}/photos?limit=2&cursor=${first.nextCursor}`))
        .body,
    );
    expect(second.photos.some((photo) => first.photos.some((other) => other.id === photo.id))).toBe(
      false,
    );
    expect((await agent.call("get", `projects/${projectId}/photos?limit=61`)).status).toBe(400);
    await fresh(owner);
    const events = auditEventsResponseSchema
      .parse((await owner.call("get", "tenants/current/audit")).body)
      .events.filter((event) => event.action === "photo.uploaded");
    expect(events.length).toBeGreaterThan(5);
    const text = JSON.stringify(events);
    expect(text).not.toContain(String(at(30, 20).lat));
    expect(text).not.toContain("Columns cast");
    expect(text).not.toContain("IMG_0001");
  });
});
