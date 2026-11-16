import { HttpException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { normalizeKenyanPhone } from "@pm-buddy/domain";
import { pinAllowed } from "@pm-buddy/types";
import type { Request } from "express";
import { z } from "zod";
import { AppConfig } from "../../config/app-config.js";
import { PrismaService } from "../../infra/prisma.service.js";
import { RedisService } from "../../infra/redis.service.js";
import { AuthSecurity, digest, opaqueToken } from "../identity/auth-security.service.js";
import { AuthService, requestId } from "../identity/auth.service.js";
import { PinService } from "../identity/pin.service.js";
import { grantOf } from "../identity/role-grants.js";
import { TenantDatabase } from "../identity/tenant-database.service.js";
import { PortalsService } from "./portals.service.js";

const callback = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  serviceCode: z.string().max(40),
  phoneNumber: z.string().max(20),
  text: z.string().max(200),
});
const stateSchema = z.object({
  step: z.number().int(),
  locale: z.enum(["en", "sw"]),
  idNumber: z.string().optional(),
  sessionId: z.uuid().optional(),
  companies: z.array(z.object({ id: z.uuid(), name: z.string() })).optional(),
});
type State = z.infer<typeof stateSchema>;
const TTL = 180;
const text = {
  en: {
    id: "CON Enter your ID/passport number",
    pin: "CON Enter your 6-digit PIN",
    company: "CON Choose company",
    menu: "CON 1. Days this month\n2. Latest submitted pay\n3. Payments\n4. Advances\n0. Exit",
    ended: "END Session ended.",
    unavailable: "END Unable to verify or show your records. Ask your project manager.",
    expired: "END Session expired. Dial again.",
    limited: "END Too many attempts. Try later or reset your PIN in the worker portal.",
    failed: "END Service unavailable. Please try later.",
    days: "Confirmed days this month",
    pay: "Submitted net pay (not payment)",
    noPay: "END No submitted pay yet.",
    payments: "END Payroll payments are not available yet. Submitted pay is not proof of payment.",
    advances: "Outstanding advances",
  },
  sw: {
    id: "CON Weka nambari ya kitambulisho/pasipoti",
    pin: "CON Weka PIN yako ya tarakimu 6",
    company: "CON Chagua kampuni",
    menu: "CON 1. Siku mwezi huu\n2. Mshahara uliowasilishwa\n3. Malipo\n4. Malipo ya mapema\n0. Toka",
    ended: "END Umeondoka.",
    unavailable: "END Hatuwezi kuthibitisha au kuonyesha rekodi zako. Wasiliana na msimamizi.",
    expired: "END Muda umeisha. Piga tena.",
    limited: "END Majaribio mengi. Jaribu baadaye au badilisha PIN kwenye tovuti ya mfanyakazi.",
    failed: "END Huduma haipatikani. Jaribu baadaye.",
    days: "Siku zilizothibitishwa mwezi huu",
    pay: "Mshahara halisi uliowasilishwa (si malipo)",
    noPay: "END Hakuna mshahara uliowasilishwa bado.",
    payments:
      "END Rekodi za malipo ya mshahara hazipatikani bado. Mshahara uliowasilishwa si uthibitisho wa malipo.",
    advances: "Salio la malipo ya mapema",
  },
};

/** Gateway sessions are phone/code-bound, encrypted, short-lived, sequential and never store a PIN. */
@Injectable()
export class UssdService {
  private readonly logger = new Logger(UssdService.name);
  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly security: AuthSecurity,
    private readonly pins: PinService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly db: TenantDatabase,
    private readonly portals: PortalsService,
  ) {}

  async handle(body: unknown, req: Request): Promise<string> {
    const input = callback.parse(body);
    const phone = normalizeKenyanPhone(input.phoneNumber);
    if (!phone || input.serviceCode !== this.config.get("USSD_SERVICE_CODE"))
      return text.en.unavailable;
    const key = `pmb:ussd:${digest(`${input.sessionId}:${phone}:${input.serviceCode}`)}`;
    const lockKey = `${key}:lock`;
    const lock = opaqueToken();
    let state: State | undefined;
    await this.security.limit(`ussd:${phone}`, 40, 300);
    await this.redis.ping();
    if (!(await this.redis.client.set(lockKey, lock, "EX", 30, "NX"))) return text.en.failed;
    try {
      const saved = await this.redis.client.get(key);
      if (!input.text) {
        if (saved) return text.en.expired;
        await this.save(key, { step: 0, locale: "en" });
        return "CON PM-Buddy\n1. English\n2. Kiswahili";
      }
      if (!saved) return text.en.expired;
      state = stateSchema.parse(JSON.parse(await this.security.decrypt(saved, "ussd")));
      const parts = input.text.split("*");
      const answer = parts.at(-1)!;
      const t = text[state.locale];
      if (parts.length !== state.step + 1) return await this.end(key, state, t.expired);
      switch (state.step) {
        case 0:
          if (answer !== "1" && answer !== "2") return await this.end(key, state, t.ended);
          state.locale = answer === "2" ? "sw" : "en";
          state.step++;
          await this.save(key, state);
          return text[state.locale].id;
        case 1:
          if (!/^[A-Za-z0-9]{4,20}$/.test(answer)) return await this.end(key, state, t.unavailable);
          state.idNumber = answer;
          state.step++;
          await this.save(key, state);
          return t.pin;
        case 2: {
          if (!/^\d{6}$/.test(answer)) return await this.end(key, state, t.unavailable);
          const session = await this.pins.authenticate(phone, answer, req);
          state.sessionId = session.id;
          await this.prisma.session.update({
            where: { id: session.id },
            data: {
              expiresAt: new Date(Date.now() + TTL * 1000),
              idleExpiresAt: new Date(Date.now() + TTL * 1000),
            },
          });
          const principal = await this.auth.sessionPrincipal(session.id);
          this.auth.requireMfa(principal);
          const memberships = await this.db.run(
            { userId: session.userId, tenantId: null, requestId: requestId(req) },
            (tx) =>
              tx.membership.findMany({
                where: { userId: session.userId },
                include: { tenant: { select: { id: true, name: true } }, customRole: true },
                orderBy: { tenantId: "asc" },
              }),
          );
          state.companies = memberships
            .filter((row) => pinAllowed(grantOf(row).permissions))
            .map((row) => row.tenant);
          if (!state.companies.length || state.companies.length > 4)
            return await this.end(key, state, t.unavailable);
          state.step++;
          await this.save(key, state);
          return `${t.company}\n${state.companies.map((row, i) => `${i + 1}. ${safeName(row.name)}`).join("\n")}`;
        }
        case 3: {
          const company = /^[1-4]$/.test(answer)
            ? state.companies?.[Number(answer) - 1]
            : undefined;
          if (!company || !state.sessionId || !state.idNumber)
            return await this.end(key, state, t.unavailable);
          await this.prisma.session.update({
            where: { id: state.sessionId },
            data: { activeTenantId: company.id },
          });
          const principal = await this.auth.sessionPrincipal(state.sessionId);
          await this.portals.worker(principal, req, state.idNumber);
          state.step++;
          await this.save(key, state);
          return t.menu;
        }
        case 4: {
          if (!state.sessionId || !state.idNumber || !["0", "1", "2", "3", "4"].includes(answer))
            return await this.end(key, state, t.ended);
          if (answer === "0") return await this.end(key, state, t.ended);
          const data = await this.portals.worker(
            await this.auth.sessionPrincipal(state.sessionId),
            req,
            state.idNumber,
          );
          let result: string;
          if (answer === "1") result = `END ${t.days}: ${data.attendance?.daysWorked ?? 0}`;
          else if (answer === "2") {
            const line = data.pay?.lines[0];
            result = line
              ? `END ${t.pay}\n${safeName(line.project)}\n${calendarDate(line.from)} - ${calendarDate(line.to)}\n${kes(line.netMinor)}`
              : t.noPay;
          } else if (answer === "3") result = t.payments;
          else result = `END ${t.advances}: ${kes(data.pay?.advancesOutstandingMinor ?? "0")}`;
          return await this.end(key, state, result);
        }
        default:
          return await this.end(key, state, t.expired);
      }
    } catch (error) {
      const t = text[state?.locale ?? "en"];
      const status = error instanceof HttpException ? error.getStatus() : 500;
      if (status >= 500) this.logger.error({ event: "ussd_failed", status }, "USSD request failed");
      return await this.end(
        key,
        state,
        status === 429 ? t.limited : status < 500 ? t.unavailable : t.failed,
      );
    } finally {
      await this.redis.client.eval(
        "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
        1,
        lockKey,
        lock,
      );
    }
  }

  private async save(key: string, state: State) {
    const value = await this.security.encrypt(JSON.stringify(state), "ussd", "3m");
    // Keep the original deadline rather than extending it with each menu step.
    const remaining = await this.redis.client.ttl(key);
    if (remaining <= 0 && state.step !== 0) throw new UnauthorizedException("USSD session expired");
    await this.redis.client.set(key, value, "EX", remaining > 0 ? remaining : TTL);
  }

  private async end(key: string, state: State | undefined, response: string) {
    if (state?.sessionId)
      await this.prisma.session.updateMany({
        where: { id: state.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    await this.redis.client.del(key);
    return response;
  }
}

function safeName(value: string) {
  return value.replace(/[^\p{L}\p{N} .&'-]/gu, " ").slice(0, 20);
}

function kes(minor: string) {
  const amount = BigInt(minor);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? "-" : ""}KES ${(absolute / 100n).toLocaleString("en-KE")}.${String(absolute % 100n).padStart(2, "0")}`;
}

function calendarDate(value: string) {
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}
