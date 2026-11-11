import { checkConversionRule, KENYAN_STARTER_CATALOGUE } from "@pm-buddy/domain";
import type { Prisma } from "../../generated/prisma/client.js";
import { nextMaterialCode, nextId } from "./catalogue-store.js";
import { fromCalendarDate, type Tx } from "./procurement-mappers.js";

export type StarterSummary = { created: number; existing: number; conversions: number };

/**
 * Loads the Kenyan starter catalogue (packages/domain KENYAN_STARTER_CATALOGUE) into a company:
 * materials whose name already exists are left as they are, so the load is idempotent. Their
 * assumption-labelled factors become material conversions effective from `today`.
 */
export async function loadStarterCatalogue(
  tx: Tx,
  tenantId: string,
  userId: string,
  today: string,
): Promise<StarterSummary> {
  const summary: StarterSummary = { created: 0, existing: 0, conversions: 0 };
  const names = new Set(
    (await tx.material.findMany({ where: { tenantId }, select: { name: true } })).map((row) =>
      row.name.toLowerCase(),
    ),
  );
  for (const starter of KENYAN_STARTER_CATALOGUE) {
    if (names.has(starter.name.toLowerCase())) {
      summary.existing += 1;
      continue;
    }
    const id = nextId();
    await tx.material.create({
      data: {
        id,
        tenantId,
        code: await nextMaterialCode(tx, tenantId),
        name: starter.name,
        nameSw: starter.nameSw,
        category: starter.category,
        baseUnit: starter.baseUnit,
        spec: starter.spec,
        attributes: starter.attributes as Prisma.InputJsonValue,
        createdBy: userId,
        updatedBy: userId,
      },
    });
    summary.created += 1;
    for (const conversion of starter.conversions) {
      const check = checkConversionRule(conversion);
      if (!check.ok) throw new Error(`Starter conversion for ${starter.name} is invalid`);
      await tx.unitConversion.create({
        data: {
          id: nextId(),
          tenantId,
          materialId: id,
          fromUnit: conversion.fromUnit,
          fromQuantity: conversion.fromQuantity,
          toUnit: conversion.toUnit,
          toQuantity: conversion.toQuantity,
          pairKey: check.pairKey,
          effectiveFrom: fromCalendarDate(today),
          note: conversion.note,
          createdBy: userId,
        },
      });
      summary.conversions += 1;
    }
  }
  return summary;
}
