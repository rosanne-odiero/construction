import { expect, test } from "@playwright/test";
import { axeViolations, BASE_URL } from "./live-helpers";

test("the review home lists what is waiting on the owner, in EN and SW", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const waiting = page.getByRole("region", { name: "Waiting on you" });
  await expect(waiting.getByRole("heading", { level: 3 })).toHaveText([
    "A real, anonymised Kenyan BQ",
    "Native Kiswahili review",
    "QS check of the starter catalogue",
    "Tax and payroll sign-off",
  ]);
  await expect(waiting.getByText("Needed for D2.2 sign-off")).toBeVisible();
  await expect(waiting.getByRole("link", { name: "Go to projects" })).toHaveAttribute(
    "href",
    "/projects",
  );
  await expect(waiting.getByRole("link", { name: "Open the catalogue" })).toHaveAttribute(
    "href",
    "/catalogue",
  );
  expect(await axeViolations(page)).toEqual([]);

  await context.addCookies([{ name: "NEXT_LOCALE", value: "sw", url: BASE_URL }]);
  await page.reload();
  const sw = page.getByRole("region", { name: "Tunasubiri kutoka kwako" });
  await expect(sw.getByText("Inahitajika kwa idhini ya D2.2")).toBeVisible();
  await expect(sw.getByRole("link", { name: "Nenda kwenye miradi" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
