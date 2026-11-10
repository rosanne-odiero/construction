"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { maskPhone, normalizeKenyanPhone } from "@/lib/format";

export function SignInForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [identifier, setIdentifier] = useState("wanjiru@jengabora.example");
  const [phone, setPhone] = useState("0712 345 678");
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const normalised = normalizeKenyanPhone(phone);

  const submitCredentials = (event: React.FormEvent) => {
    event.preventDefault();
    if (method === "phone" && !normalised) {
      toast.error(t("phoneInvalid"));
      return;
    }
    setStep("mfa");
  };

  const verify = (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setTimeout(() => router.push("/dashboard"), 600);
  };

  if (step === "mfa") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </span>
          <CardTitle className="text-xl">{t("mfaTitle")}</CardTitle>
          <CardDescription>{t("mfaDescription")}</CardDescription>
        </CardHeader>
        <form onSubmit={verify}>
          <CardContent className="space-y-4">
            <Field>
              <FieldLabel htmlFor="otp">{t("codeLabel")}</FieldLabel>
              <InputOTP id="otp" maxLength={6} value={code} onChange={setCode} autoFocus>
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
              <FieldDescription>{t("codeHint")}</FieldDescription>
            </Field>
            <Button type="submit" className="w-full" disabled={code.length < 6 || busy}>
              {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              {t("verify")}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              {t("or")}
              <Separator className="flex-1" />
            </div>
            <div className="grid gap-2">
              <Button type="button" variant="outline" onClick={() => toast.info(t("passkeyToast"))}>
                <KeyRound aria-hidden /> {t("usePasskey")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  toast.success(t("smsToast", { phone: maskPhone(normalised ?? "254712345678") }))
                }
              >
                <MessageSquareText aria-hidden /> {t("useSms")}
              </Button>
            </div>
          </CardContent>
        </form>
        <CardFooter className="justify-between">
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() => setStep("credentials")}
          >
            <ArrowLeft aria-hidden /> {t("back")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("mfaRequiredNote")}</span>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <form onSubmit={submitCredentials}>
        <CardContent>
          <FieldGroup>
            <Tabs value={method} onValueChange={(v) => setMethod(v as "email" | "phone")}>
              <TabsList className="w-full">
                <TabsTrigger value="email">{t("emailTab")}</TabsTrigger>
                <TabsTrigger value="phone">{t("phoneTab")}</TabsTrigger>
              </TabsList>
            </Tabs>
            {method === "email" ? (
              <Field>
                <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </Field>
            ) : (
              <Field>
                <FieldLabel htmlFor="phone">{t("phone")}</FieldLabel>
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="username"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  aria-invalid={!normalised}
                  required
                />
                <FieldDescription>
                  {normalised ? t("phoneNormalised", { phone: normalised }) : t("phoneInvalid")}
                </FieldDescription>
              </Field>
            )}
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="password">{t("password")}</FieldLabel>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 text-xs"
                  onClick={() => toast.info(t("resetToast"))}
                >
                  {t("forgot")}
                </Button>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  defaultValue="correct-horse-battery"
                  className="pr-10"
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                </Button>
              </div>
            </Field>
            <Button type="submit" className="w-full">
              {t("continue")}
            </Button>
          </FieldGroup>
        </CardContent>
      </form>
      <CardFooter>
        <p className="text-xs text-muted-foreground">{t("prototypeNote")}</p>
      </CardFooter>
    </Card>
  );
}
