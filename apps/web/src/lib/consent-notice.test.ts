import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LABOUR_CONSENT_NOTICES } from "@pm-buddy/types";
import { catalogues, LOCALES } from "@pm-buddy/i18n";

/**
 * A published consent notice never changes silently: the digest of its text in each language is
 * pinned in packages/types (LABOUR_CONSENT_NOTICES) and stored with every consent record. Changing
 * the wording means adding a new notice version (and a migration-free new catalogue key).
 */
describe("labour consent notices", () => {
  it("match the pinned digests in every language", () => {
    const notices = catalogues.en.labourConsentNotices as Record<string, object>;
    for (const notice of LABOUR_CONSENT_NOTICES) {
      expect(notices[notice.messageKey], notice.version).toBeDefined();
      for (const locale of LOCALES) {
        const text = (catalogues[locale].labourConsentNotices as Record<string, object>)[
          notice.messageKey
        ];
        const digest = createHash("sha256").update(JSON.stringify(text)).digest("hex");
        expect(digest, `${notice.version} (${locale})`).toBe(notice.digests[locale]);
      }
    }
  });

  it("name the data controller and the purposes in both languages", () => {
    for (const locale of LOCALES) {
      const notice = catalogues[locale].labourConsentNotices.registrationV1;
      for (const text of [notice.title, notice.who, notice.share, notice.question])
        expect(text).toContain("{company}");
      expect(notice.rights).toContain("ODPC");
    }
  });
});
