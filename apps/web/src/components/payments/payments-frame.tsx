import { PageHeader } from "@/components/page-header";
import { PaymentsNav, type PaymentsNavKey } from "./payments-nav";

/** Header and navigation shared by the D4.3 payments pages (reconciliation, statements, tariffs). */
export function PaymentsFrame({
  current,
  title,
  description,
  canTest,
  children,
}: {
  current: PaymentsNavKey;
  title: string;
  description?: string;
  canTest: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader title={title} description={description} />
      <PaymentsNav current={current} canTest={canTest} />
      {children}
    </div>
  );
}
