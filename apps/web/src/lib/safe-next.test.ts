import { expect, it } from "vitest";
import { safeNextPath, signInHref } from "./safe-next";

it("accepts same-site relative paths with their query and fragment", () => {
  expect(safeNextPath("/projects")).toBe("/projects");
  expect(safeNextPath("/projects/abc?tab=sites#map")).toBe("/projects/abc?tab=sites#map");
  expect(signInHref("/projects/abc?tab=team")).toBe("/sign-in?next=%2Fprojects%2Fabc%3Ftab%3Dteam");
});

it("refuses absolute, protocol-relative, backslash and looping destinations", () => {
  for (const value of [
    "https://evil.example/projects",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "projects",
    "/sign-in?next=/projects",
    "/api/v1/auth/logout",
    "/projects\nSet-Cookie: x",
    "",
    "/".padEnd(600, "a"),
    undefined,
    ["/projects"],
  ])
    expect(safeNextPath(value), String(value)).toBe("/projects");
});
