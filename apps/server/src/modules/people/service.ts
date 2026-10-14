import { and, desc, eq, inArray, isNull, lte, or, gte } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, type ScheduleVersion } from '@openpers/shared';
import type { Exec } from '../../db';
import { employmentCostCenters, employmentOrgUnits, employments, persons, workSchedules, workplaces, legalEntities, company } from '../../db/schema';
import { audit, emit } from '../../lib/context';
import { conflict } from '../../lib/errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoDateSchema = isoDate;

export const weeklyHoursSchema = z.array(z.number().min(0).max(24)).length(7);

export const employmentInput = z.object({
  startDate: isoDate,
  endDate: isoDate.nullish(),
  probationEndDate: isoDate.nullish(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ONBOARDING', 'LEAVE']).default('ACTIVE'),
  type: z.enum(['INTERNAL', 'EXTERNAL']).default('INTERNAL'),
  contractType: z.enum(['PERMANENT', 'FIXED_TERM', 'WORKING_STUDENT', 'MINI_JOB', 'INTERN', 'TRAINEE']).default('PERMANENT'),
  employeeNumber: z.string().max(50).nullish(),
  positionTitle: z.string().max(200).nullish(),
  legalEntityId: z.string().uuid().nullish(),
  workplaceId: z.string().uuid().nullish(),
  supervisorPersonId: z.string().uuid().nullish(),
  orgUnitIds: z.array(z.string().uuid()).default([]),
  costCenters: z.array(z.object({ id: z.string().uuid(), weight: z.number().int().min(0).max(100) })).default([]),
  weeklyHours: weeklyHoursSchema.default([8, 8, 8, 8, 8, 0, 0]),
  fullTimeWeeklyHours: z.number().min(1).max(80).default(40),
});

export const personInput = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  preferredName: z.string().max(100).nullish(),
  email: z.string().trim().toLowerCase().email(),
  gender: z.enum(['MALE', 'FEMALE', 'DIVERSE', 'UNKNOWN']).default('UNKNOWN'),
  birthDate: isoDate.nullish(),
  phone: z.string().max(50).nullish(),
  privateAddress: z.string().max(500).nullish(),
  emergencyContact: z.string().max(500).nullish(),
  language: z.string().max(5).default('de'),
});

export const createPersonInput = personInput.extend({ employment: employmentInput });
export type CreatePersonInput = z.input<typeof createPersonInput>;

export async function createPersonWithEmployment(tx: Exec, raw: CreatePersonInput, actorUserId: string | null) {
  const input = createPersonInput.parse(raw);
  const existing = await tx.select({ id: persons.id }).from(persons).where(eq(persons.email, input.email));
  if (existing.length) throw conflict('A person with this email already exists');
  const { employment: emp, ...personData } = input;
  const [person] = await tx.insert(persons).values(personData).returning();
  const [employment] = await tx
    .insert(employments)
    .values({
      personId: person.id,
      startDate: emp.startDate,
      endDate: emp.endDate ?? null,
      probationEndDate: emp.probationEndDate ?? null,
      status: emp.status,
      type: emp.type,
      contractType: emp.contractType,
      employeeNumber: emp.employeeNumber ?? null,
      positionTitle: emp.positionTitle ?? null,
      legalEntityId: emp.legalEntityId ?? null,
      workplaceId: emp.workplaceId ?? null,
      supervisorPersonId: emp.supervisorPersonId ?? null,
    })
    .returning();
  if (emp.orgUnitIds.length) await tx.insert(employmentOrgUnits).values(emp.orgUnitIds.map((orgUnitId) => ({ employmentId: employment.id, orgUnitId })));
  if (emp.costCenters.length) await tx.insert(employmentCostCenters).values(emp.costCenters.map((c) => ({ employmentId: employment.id, costCenterId: c.id, weight: c.weight })));
  await tx.insert(workSchedules).values({ employmentId: employment.id, validFrom: emp.startDate, hours: emp.weeklyHours, fullTimeWeeklyHours: emp.fullTimeWeeklyHours });
  await audit(tx, actorUserId, 'person', person.id, 'create', { email: person.email });
  await emit(tx, 'person.created', { personId: person.id, employmentId: employment.id });
  return { personId: person.id, employmentId: employment.id };
}

/** The employment relevant at `date` (latest started one that has not ended). */
export async function currentEmployment(db: Exec, personId: string, date: string) {
  const list = await db
    .select()
    .from(employments)
    .where(and(eq(employments.personId, personId), lte(employments.startDate, date), or(isNull(employments.endDate), gte(employments.endDate, date))))
    .orderBy(desc(employments.startDate))
    .limit(1);
  if (list[0]) return list[0];
  const any = await db.select().from(employments).where(eq(employments.personId, personId)).orderBy(desc(employments.startDate)).limit(1);
  return any[0];
}

/** All work schedule versions of all employments of a person, as ScheduleVersions. */
export async function schedulesOf(db: Exec, personId: string): Promise<ScheduleVersion[]> {
  const emps = await db.select({ id: employments.id, startDate: employments.startDate, endDate: employments.endDate }).from(employments).where(eq(employments.personId, personId));
  if (!emps.length) return [];
  const rows = await db.select().from(workSchedules).where(inArray(workSchedules.employmentId, emps.map((e) => e.id)));
  const versions: ScheduleVersion[] = rows.map((r) => ({ validFrom: r.validFrom, hours: r.hours }));
  // Days after an employment ended (and before a later one starts) have no working hours;
  // a later employment's schedule version (later validFrom) takes precedence again.
  for (const e of emps) {
    if (!e.endDate) continue;
    const after = addDays(e.endDate, 1);
    if (!versions.some((v) => v.validFrom === after)) versions.push({ validFrom: after, hours: [0, 0, 0, 0, 0, 0, 0] });
  }
  return versions;
}

/** Region (for public holidays) of a person: workplace → legal entity → company default. */
export async function regionOf(db: Exec, personId: string, date: string): Promise<string> {
  const emp = await currentEmployment(db, personId, date);
  if (emp?.workplaceId) {
    const [w] = await db.select({ region: workplaces.region }).from(workplaces).where(eq(workplaces.id, emp.workplaceId));
    if (w) return w.region;
  }
  if (emp?.legalEntityId) {
    const [l] = await db.select({ region: legalEntities.region }).from(legalEntities).where(eq(legalEntities.id, emp.legalEntityId));
    if (l) return l.region;
  }
  const [c] = await db.select({ region: company.region }).from(company).limit(1);
  return c?.region ?? 'DE-BE';
}
