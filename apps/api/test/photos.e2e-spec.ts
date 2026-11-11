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
import { jpegWithExif, plainJpeg, type PhotoSpec } from "./photo-fixtures.js";
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
  const uploaded = async (content: Buffer, fields?: Record<string, string>, who = agent) => {
    const res = await upload(who, content, fields);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return sitePhotoResponseSchema.parse(res.body).photo;
  };
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
        projectIds: [projectId],
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
      "uploadSitePhoto",
      "getSitePhotoThumbnail",
      "getSitePhotoOriginal",
    ])
      expect(operations).toContain(id);
  });

  it("verifies a recent photo taken inside the site and stores the original and a clean thumbnail", async () => {
    const content = await jpegWithExif(taken(HOUR, at(30, 20), { width: 1600, height: 1200 }));
    const photo = await uploaded(content, { siteId, caption: "  Columns cast  " });
    expect(photo).toMatchObject({
      siteId,
      diaryId: null,
      caption: "Columns cast",
      timeSource: "offset",
      camera: "TestCam Field 1",
      width: 1600,
      height: 1200,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      geofenceVersion: 1,
      checks: { location: "inside", time: "ok", distanceM: null },
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

  it("records why a photo is not verified: outside the site, no metadata, old or future", async () => {
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
    expect(assumed).toMatchObject({ timeSource: "assumed_nairobi", verified: true });
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
    expect(early).toMatchObject({ verified: true, geofenceVersion: 1 });
    // EXIF times are whole seconds: take the later photo just after the change.
    const late = await uploaded(await jpegWithExif(taken(-5_000, at(30, -400))), {
      siteId: otherSite,
    });
    expect(late).toMatchObject({
      verified: false,
      geofenceVersion: 2,
      checks: { location: "outside" },
    });
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
    const linked = await uploaded(await jpegWithExif(taken(60_000)), { siteId, diaryId: today.id });
    expect(linked).toMatchObject({ diaryId: today.id, verified: true });
    const earlier = await create("2026-01-15");
    const mismatch = await uploaded(await jpegWithExif(taken(60_000)), {
      siteId,
      diaryId: earlier.id,
    });
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

  it("refuses duplicates, non-JPEG, undecodable, oversized and pixel-bomb uploads", async () => {
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
    for (const data of [
      { ...base, locationCheck: "outside", verified: true },
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
