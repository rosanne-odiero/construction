import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { BASE_URL } from "./live-helpers";

for (const locale of ["en", "sw"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`gallery is accessible in ${locale}, ${theme}`, async ({ page, context }) => {
      await context.addCookies([{ name: "NEXT_LOCALE", value: locale, url: BASE_URL }]);
      await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
      await page.goto("/design-system");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        locale === "en" ? "Design system" : "Mfumo wa usanifu",
      );
      await expect(page.getByText("KES 1,250,000", { exact: true })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", {
          name: locale === "en" ? "Skip to main content" : "Nenda kwenye maudhui makuu",
        }),
      ).toBeFocused();
      const scan = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(scan.violations).toEqual([]);
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`primary buttons keep text contrast while hovered (${theme})`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("theme", value), theme);
    await page.goto("/design-system");
    if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    const button = page
      .locator('[data-slot="button"][data-variant="default"]:not([disabled])')
      .first();
    await button.hover();
    await page.waitForTimeout(400); // let the colour transition finish
    await button.evaluate((element) => element.setAttribute("data-hover-under-test", ""));
    const scan = await new AxeBuilder({ page })
      .include("[data-hover-under-test]")
      .withRules(["color-contrast"])
      .analyze();
    expect(scan.violations).toEqual([]);
    expect(scan.passes.map((rule) => rule.id)).toContain("color-contrast");
  });
}

test("gallery fits a low-width Android viewport and exposes an install manifest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/design-system");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");
  const response = await page.request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ start_url: "/foundation", display: "standalone" });
});
