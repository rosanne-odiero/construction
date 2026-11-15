import { PaymentsPage } from "@/components/payments/console-page";

export default async function Page({ params, searchParams }: {
  params: Promise<{ segments: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <PaymentsPage segments={(await params).segments} search={await searchParams} />;
}
