import { Injectable, NotFoundException } from "@nestjs/common";
import {
  addCalendarDays,
  assessCubes,
  assessSlump,
  classStrength,
  cubeAgeState,
  cubeDueDate,
  nairobiDate,
} from "@pm-buddy/domain";
import { CUBE_TEST_AGES, type ConcreteClass, type CubeTestAge } from "@pm-buddy/types";
import {
  cubeSetResponseSchema,
  cubeSetSchema,
  cubeSetsResponseSchema,
  slumpTestResponseSchema,
  slumpTestSchema,
  slumpTestsResponseSchema,
  type CorrectCubeResultRequest,
  type CorrectSlumpTestRequest,
  type CreateCubeSetRequest,
  type CreateSlumpTestRequest,
  type CubeResult,
  type CubeSetsQuery,
  type RecordCubeResultRequest,
  type SlumpTest,
  type SlumpTestsQuery,
} from "@pm-buddy/validation";
import type { Request } from "express";
import { isUniqueViolation } from "../../common/database-errors.js";
import { uuidv7 } from "../../common/uuid.js";
import type { Prisma } from "../../generated/prisma/client.js";
import type { Scope } from "../identity/access-policy.js";
import type { Principal } from "../identity/auth.service.js";
import { TenantScope } from "../identity/tenant-scope.service.js";
import { peopleOf, personOf, type People } from "../procurement/procurement-mappers.js";
import { fromCalendarDate, toCalendarDate } from "../projects/project-mappers.js";
import {
  futureDate,
  lockProject,
  QualityAccess,
  qualityProblem,
  qualitySettings,
  recordCode,
  requireSite,
  versionConflict,
  type QualityContext,
} from "./quality-access.js";

const cubeInclude = {
  site: { select: { name: true } },
  results: { include: { supersededBy: { select: { id: true } } }, orderBy: { recordedAt: "desc" } },
} as const;
type CubeSetRow = Prisma.CubeSetGetPayload<{ include: typeof cubeInclude }>;
type CubeResultRow = CubeSetRow["results"][number];
const slumpInclude = {
  site: { select: { name: true } },
  cubeSet: { select: { id: true, number: true } },
  supersededBy: { select: { id: true } },
} as const;
type SlumpRow = Prisma.SlumpTestGetPayload<{ include: typeof slumpInclude }>;

const toResult = (row: CubeResultRow, concreteClass: ConcreteClass, people: People): CubeResult => {
  const strengths = row.strengths.map((value) => value.toFixed(1));
  return {
    id: row.id,
    ageDays: row.ageDays as CubeTestAge,
    testedOn: toCalendarDate(row.testedOn),
    strengths,
    meanStrength: row.meanStrength.toFixed(2),
    minStrength: row.minStrength.toFixed(1),
    percentOfClass: assessCubes(concreteClass, row.ageDays as CubeTestAge, strengths)
      .percentOfClass,
    outcome: row.outcome as CubeResult["outcome"],
    ruleVersion: row.ruleVersion,
    laboratory: row.laboratory,
    reportReference: row.reportReference,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    current: row.supersededBy === null,
    recordedBy: personOf(people, row.recordedBy),
    recordedAt: row.recordedAt.toISOString(),
  };
};

/**
 * Concrete tests (D6.1): cube sets with 7- and 28-day crushing results judged by rule KE-CUBE-1
 * and slump tests judged by KE-SLUMP-1 (packages/types, COMPLIANCE-REVIEW CR-QA-01/02). Results
 * and slump tests are append-only; a correction supersedes the current record once, with a
 * reason, and needs quality.manage. A cube result is overdue after its due date plus the
 * company's grace days (Africa/Nairobi).
 */
@Injectable()
export class ConcreteService {
  constructor(
    private readonly scope: TenantScope,
    private readonly quality: QualityAccess,
  ) {}

  listCubes(principal: Principal, projectId: string, query: CubeSetsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      const { tenantId } = scope.access;
      const { cubeOverdueGraceDays: grace } = await qualitySettings(scope.tx, tenantId);
      const overdue = this.overdueWhere(grace);
      const failed: Prisma.CubeSetWhereInput = {
        results: { some: { ageDays: 28, outcome: "fail", supersededBy: { is: null } } },
      };
      const where: Prisma.CubeSetWhereInput = {
        tenantId,
        projectId,
        ...(query.filter === "overdue" ? overdue : query.filter === "failed" ? failed : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const numbered = /^(?:CUBE-?)?0*(\d{1,9})$/i.exec(search);
        where.AND = [
          {
            OR: [
              { element: { contains: search, mode: "insensitive" } },
              { batchReference: { contains: search, mode: "insensitive" } },
              ...(numbered ? [{ number: Number(numbered[1]) }] : []),
            ],
          },
        ];
      }
      const [rows, overdueCount, failedCount] = await Promise.all([
        scope.tx.cubeSet.findMany({
          where,
          include: cubeInclude,
          orderBy: { number: "desc" },
          take: query.limit + 1,
        }),
        scope.tx.cubeSet.count({ where: { tenantId, projectId, ...overdue } }),
        scope.tx.cubeSet.count({ where: { tenantId, projectId, ...failed } }),
      ]);
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(
        scope.tx,
        page.flatMap((row) => [row.createdBy, ...row.results.map((result) => result.recordedBy)]),
      );
      return cubeSetsResponseSchema.parse({
        cubeSets: page.map((row) => this.toCubeSet(row, people, context, grace)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        counts: { overdue: overdueCount, failed: failedCount },
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  getCubes(principal: Principal, projectId: string, cubeSetId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      return this.cubeDetail(scope, context, cubeSetId);
    });
  }

  createCubes(principal: Principal, projectId: string, input: CreateCubeSetRequest, req: Request) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.recorder(scope, projectId);
        const { tenantId, userId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        futureDate(input.castOn);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.cubeSet.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const id = uuidv7();
        const number = (latest?.number ?? 0) + 1;
        await scope.tx.cubeSet.create({
          data: {
            id,
            tenantId,
            projectId,
            siteId: input.siteId,
            number,
            element: input.element,
            concreteClass: input.concreteClass,
            specifiedStrength: classStrength(input.concreteClass),
            castOn: fromCalendarDate(input.castOn),
            cubesPerAge: input.cubesPerAge,
            batchReference: input.batchReference,
            notes: input.notes,
            createdBy: userId,
          },
        });
        await this.scope.audit(scope.tx, "quality.cube_set_recorded", id, {
          projectId,
          siteId: input.siteId,
          number,
          concreteClass: input.concreteClass,
          castOn: input.castOn,
        });
        return this.cubeDetail(scope, context, id);
      },
      true,
    );
  }

  recordResult(
    principal: Principal,
    projectId: string,
    cubeSetId: string,
    input: RecordCubeResultRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const context = await this.quality.recorder(scope, projectId);
          const set = await this.activeSet(scope, projectId, cubeSetId);
          const existing = await scope.tx.cubeResult.findFirst({
            where: { tenantId: scope.access.tenantId, cubeSetId, ageDays: input.ageDays },
            select: { id: true },
          });
          if (existing)
            throw qualityProblem(
              409,
              "cube-result-exists",
              "This age already has a result: correct it instead",
            );
          const assessment = this.dates(set, input.testedOn, input.ageDays, input.strengths);
          const id = await this.writeResult(scope, set, input.ageDays, input, assessment, null);
          await this.scope.audit(scope.tx, "quality.cube_result_recorded", id, {
            projectId,
            cubeSetId,
            setNumber: set.number,
            ageDays: input.ageDays,
            cubes: input.strengths.length,
            meanStrength: assessment.meanStrength,
            outcome: assessment.outcome,
          });
          return this.cubeDetail(scope, context, cubeSetId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw qualityProblem(409, "cube-result-exists", "This age already has a result");
        throw error;
      });
  }

  correctResult(
    principal: Principal,
    projectId: string,
    cubeSetId: string,
    resultId: string,
    input: CorrectCubeResultRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const context = await this.quality.reviewer(scope, projectId);
          const set = await this.activeSet(scope, projectId, cubeSetId);
          const previous = await scope.tx.cubeResult.findFirst({
            where: { tenantId: scope.access.tenantId, projectId, cubeSetId, id: resultId },
            include: { supersededBy: { select: { id: true } } },
          });
          if (!previous) throw new NotFoundException("Cube result not found");
          if (previous.supersededBy)
            throw qualityProblem(
              409,
              "cube-result-superseded",
              "This result was already corrected: correct the newest one",
            );
          const age = previous.ageDays as CubeTestAge;
          const assessment = this.dates(set, input.testedOn, age, input.strengths);
          const id = await this.writeResult(scope, set, age, input, assessment, {
            supersedesId: previous.id,
            reason: input.reason,
          });
          await this.scope.audit(scope.tx, "quality.cube_result_corrected", id, {
            projectId,
            cubeSetId,
            setNumber: set.number,
            ageDays: age,
            supersedes: previous.id,
            outcome: { from: previous.outcome, to: assessment.outcome },
          });
          return this.cubeDetail(scope, context, cubeSetId);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw qualityProblem(409, "cube-result-superseded", "This result was already corrected");
        throw error;
      });
  }

  voidCubes(
    principal: Principal,
    projectId: string,
    cubeSetId: string,
    input: { version: number; reason: string },
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.reviewer(scope, projectId);
        const { tenantId, userId } = scope.access;
        const set = await this.activeSet(scope, projectId, cubeSetId);
        if (set.version !== input.version) throw versionConflict();
        const changed = await scope.tx.cubeSet.updateMany({
          where: { tenantId, projectId, id: cubeSetId, version: input.version, status: "active" },
          data: {
            status: "void",
            voidReason: input.reason,
            voidedBy: userId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw versionConflict();
        await this.scope.audit(scope.tx, "quality.cube_set_voided", cubeSetId, {
          projectId,
          number: set.number,
          version: input.version + 1,
        });
        return this.cubeDetail(scope, context, cubeSetId);
      },
      true,
    );
  }

  listSlump(principal: Principal, projectId: string, query: SlumpTestsQuery, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      const where: Prisma.SlumpTestWhereInput = {
        tenantId: scope.access.tenantId,
        projectId,
        supersededBy: { is: null },
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.cursor ? { number: { lt: query.cursor } } : {}),
      };
      const search = query.search?.trim();
      if (search) {
        const numbered = /^(?:SLP-?)?0*(\d{1,9})$/i.exec(search);
        where.OR = [
          { element: { contains: search, mode: "insensitive" } },
          ...(numbered ? [{ number: Number(numbered[1]) }] : []),
        ];
      }
      const rows = await scope.tx.slumpTest.findMany({
        where,
        include: slumpInclude,
        orderBy: { number: "desc" },
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const people = await peopleOf(
        scope.tx,
        page.map((row) => row.recordedBy),
      );
      return slumpTestsResponseSchema.parse({
        slumpTests: page.map((row) => this.toSlump(row, people, context)),
        nextCursor: rows.length > query.limit ? page.at(-1)!.number : null,
        permissions: { canCreate: context.canRecord },
      });
    });
  }

  getSlump(principal: Principal, projectId: string, slumpTestId: string, req: Request) {
    return this.scope.run(principal, req, async (scope) => {
      const context = await this.quality.load(scope, projectId);
      return this.slumpDetail(scope, context, slumpTestId);
    });
  }

  createSlump(
    principal: Principal,
    projectId: string,
    input: CreateSlumpTestRequest,
    req: Request,
  ) {
    return this.scope.run(
      principal,
      req,
      async (scope) => {
        const context = await this.quality.recorder(scope, projectId);
        const { tenantId } = scope.access;
        await requireSite(scope.tx, tenantId, projectId, input.siteId);
        await this.cubeSetIn(scope, projectId, input.cubeSetId);
        await lockProject(scope.tx, tenantId, projectId);
        const latest = await scope.tx.slumpTest.findFirst({
          where: { tenantId, projectId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (latest?.number ?? 0) + 1;
        const id = await this.writeSlump(scope, projectId, {
          ...input,
          number,
          supersedesId: null,
          reason: null,
        });
        return this.slumpDetail(scope, context, id);
      },
      true,
    );
  }

  correctSlump(
    principal: Principal,
    projectId: string,
    slumpTestId: string,
    input: CorrectSlumpTestRequest,
    req: Request,
  ) {
    return this.scope
      .run(
        principal,
        req,
        async (scope) => {
          const context = await this.quality.reviewer(scope, projectId);
          const previous = await scope.tx.slumpTest.findFirst({
            where: { tenantId: scope.access.tenantId, projectId, id: slumpTestId },
            include: { supersededBy: { select: { id: true } } },
          });
          if (!previous) throw new NotFoundException("Slump test not found");
          if (previous.supersededBy)
            throw qualityProblem(
              409,
              "slump-test-superseded",
              "This test was already corrected: correct the newest version",
            );
          const id = await this.writeSlump(scope, projectId, {
            ...input,
            siteId: previous.siteId,
            cubeSetId: previous.cubeSetId,
            number: previous.number,
            supersedesId: previous.id,
            reason: input.reason,
          });
          return this.slumpDetail(scope, context, id);
        },
        true,
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error))
          throw qualityProblem(409, "slump-test-superseded", "This test was already corrected");
        throw error;
      });
  }

  /** Active sets with a result past its due date and grace days (Africa/Nairobi). */
  overdueWhere(grace: number): Prisma.CubeSetWhereInput {
    const today = nairobiDate();
    return {
      status: "active",
      OR: CUBE_TEST_AGES.map((age) => ({
        castOn: { lt: fromCalendarDate(addCalendarDays(today, -(age + grace))) },
        results: { none: { ageDays: age } },
      })),
    };
  }

  private toCubeSet(row: CubeSetRow, people: People, context: QualityContext, grace: number) {
    const today = nairobiDate();
    const concreteClass = row.concreteClass as ConcreteClass;
    const castOn = toCalendarDate(row.castOn);
    const active = row.status === "active";
    const current = row.results.filter((result) => result.supersededBy === null);
    const ages = CUBE_TEST_AGES.map((age) => {
      const result = current.find((entry) => entry.ageDays === age) ?? null;
      return {
        ageDays: age,
        dueOn: cubeDueDate(castOn, age),
        state: active
          ? cubeAgeState({ castOn, ageDays: age, today, graceDays: grace, recorded: !!result })
          : result
            ? "recorded"
            : "not_due",
        result: result ? toResult(result, concreteClass, people) : null,
      };
    });
    const outcome = ages.find((age) => age.ageDays === 28)?.result?.outcome ?? null;
    return cubeSetSchema.parse({
      id: row.id,
      projectId: row.projectId,
      siteId: row.siteId,
      siteName: row.site.name,
      number: row.number,
      code: recordCode("CUBE", row.number),
      element: row.element,
      concreteClass,
      specifiedStrength: row.specifiedStrength,
      castOn,
      cubesPerAge: row.cubesPerAge,
      batchReference: row.batchReference,
      notes: row.notes,
      status: row.status,
      voidReason: row.voidReason,
      ages,
      outcome: outcome === "pass" || outcome === "fail" ? outcome : null,
      version: row.version,
      createdBy: personOf(people, row.createdBy),
      createdAt: row.createdAt.toISOString(),
      permissions: {
        canRecord: context.canRecord && active && ages.some((age) => age.result === null),
        canCorrect: context.canReview && active && current.length > 0,
        canVoid: context.canReview && active,
      },
    });
  }

  private async cubeDetail(scope: Scope, context: QualityContext, cubeSetId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.cubeSet.findFirst({
      where: { tenantId, projectId: context.project.id, id: cubeSetId },
      include: cubeInclude,
    });
    if (!row) throw new NotFoundException("Cube set not found");
    const { cubeOverdueGraceDays } = await qualitySettings(scope.tx, tenantId);
    const people = await peopleOf(scope.tx, [
      row.createdBy,
      ...row.results.map((result) => result.recordedBy),
    ]);
    return cubeSetResponseSchema.parse({
      cubeSet: this.toCubeSet(row, people, context, cubeOverdueGraceDays),
      history: row.results.map((result) =>
        toResult(result, row.concreteClass as ConcreteClass, people),
      ),
    });
  }

  private async activeSet(scope: Scope, projectId: string, cubeSetId: string) {
    const set = await scope.tx.cubeSet.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: cubeSetId },
    });
    if (!set) throw new NotFoundException("Cube set not found");
    if (set.status !== "active")
      throw qualityProblem(409, "cube-set-void", "This cube set was voided");
    return set;
  }

  private dates(
    set: { castOn: Date; concreteClass: string },
    testedOn: string,
    age: CubeTestAge,
    strengths: string[],
  ) {
    futureDate(testedOn);
    if (testedOn < toCalendarDate(set.castOn))
      throw qualityProblem(
        422,
        "cube-tested-before-cast",
        "Cubes cannot be tested before they were cast",
      );
    return assessCubes(set.concreteClass as ConcreteClass, age, strengths);
  }

  private async writeResult(
    scope: Scope,
    set: { id: string; projectId: string },
    age: CubeTestAge,
    input: {
      testedOn: string;
      strengths: string[];
      laboratory: string | null;
      reportReference: string | null;
    },
    assessment: ReturnType<typeof assessCubes>,
    correction: { supersedesId: string; reason: string } | null,
  ) {
    const id = uuidv7();
    await scope.tx.cubeResult.create({
      data: {
        id,
        tenantId: scope.access.tenantId,
        projectId: set.projectId,
        cubeSetId: set.id,
        ageDays: age,
        testedOn: fromCalendarDate(input.testedOn),
        strengths: input.strengths,
        meanStrength: assessment.meanStrength,
        minStrength: assessment.minStrength,
        outcome: assessment.outcome,
        ruleVersion: assessment.ruleVersion,
        laboratory: input.laboratory,
        reportReference: input.reportReference,
        supersedesId: correction?.supersedesId ?? null,
        correctionReason: correction?.reason ?? null,
        recordedBy: scope.access.userId,
      },
    });
    return id;
  }

  private async cubeSetIn(scope: Scope, projectId: string, cubeSetId: string | null) {
    if (!cubeSetId) return;
    const set = await scope.tx.cubeSet.findFirst({
      where: { tenantId: scope.access.tenantId, projectId, id: cubeSetId },
      select: { id: true },
    });
    if (!set) throw new NotFoundException("Cube set not found");
  }

  private async writeSlump(
    scope: Scope,
    projectId: string,
    input: Omit<CreateSlumpTestRequest, "siteId" | "cubeSetId"> & {
      siteId: string;
      cubeSetId: string | null;
      number: number;
      supersedesId: string | null;
      reason: string | null;
    },
  ) {
    futureDate(input.testedOn);
    const { outcome, ruleVersion } = assessSlump(
      input.targetMm,
      input.toleranceMm,
      input.measuredMm,
    );
    const id = uuidv7();
    await scope.tx.slumpTest.create({
      data: {
        id,
        tenantId: scope.access.tenantId,
        projectId,
        siteId: input.siteId,
        number: input.number,
        testedOn: fromCalendarDate(input.testedOn),
        element: input.element,
        concreteClass: input.concreteClass,
        cubeSetId: input.cubeSetId,
        targetMm: input.targetMm,
        toleranceMm: input.toleranceMm,
        measuredMm: input.measuredMm,
        outcome,
        ruleVersion,
        notes: input.notes,
        supersedesId: input.supersedesId,
        correctionReason: input.reason,
        recordedBy: scope.access.userId,
      },
    });
    await this.scope.audit(
      scope.tx,
      input.supersedesId ? "quality.slump_test_corrected" : "quality.slump_test_recorded",
      id,
      {
        projectId,
        number: input.number,
        outcome,
        supersedes: input.supersedesId,
      },
    );
    return id;
  }

  private toSlump(row: SlumpRow, people: People, context: QualityContext): SlumpTest {
    return slumpTestSchema.parse({
      id: row.id,
      projectId: row.projectId,
      siteId: row.siteId,
      siteName: row.site.name,
      number: row.number,
      code: recordCode("SLP", row.number),
      testedOn: toCalendarDate(row.testedOn),
      element: row.element,
      concreteClass: row.concreteClass,
      cubeSet: row.cubeSet
        ? { id: row.cubeSet.id, code: recordCode("CUBE", row.cubeSet.number) }
        : null,
      targetMm: row.targetMm,
      toleranceMm: row.toleranceMm,
      measuredMm: row.measuredMm,
      deviationMm: row.measuredMm - row.targetMm,
      outcome: row.outcome,
      ruleVersion: row.ruleVersion,
      notes: row.notes,
      supersedesId: row.supersedesId,
      correctionReason: row.correctionReason,
      current: row.supersededBy === null,
      recordedBy: personOf(people, row.recordedBy),
      recordedAt: row.recordedAt.toISOString(),
      permissions: { canCorrect: context.canReview && row.supersededBy === null },
    });
  }

  private async slumpDetail(scope: Scope, context: QualityContext, slumpTestId: string) {
    const { tenantId } = scope.access;
    const row = await scope.tx.slumpTest.findFirst({
      where: { tenantId, projectId: context.project.id, id: slumpTestId },
      include: slumpInclude,
    });
    if (!row) throw new NotFoundException("Slump test not found");
    const versions = await scope.tx.slumpTest.findMany({
      where: { tenantId, projectId: context.project.id, number: row.number },
      include: slumpInclude,
      orderBy: { recordedAt: "desc" },
    });
    const people = await peopleOf(
      scope.tx,
      versions.map((version) => version.recordedBy),
    );
    const current = versions.find((version) => version.supersededBy === null) ?? row;
    return slumpTestResponseSchema.parse({
      slumpTest: this.toSlump(current, people, context),
      history: versions
        .filter((version) => version.id !== current.id)
        .map((version) => this.toSlump(version, people, context)),
    });
  }
}
