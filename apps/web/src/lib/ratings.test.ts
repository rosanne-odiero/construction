import { describe, expect, it } from "vitest";
import { defaultRatingProject } from "./ratings";

describe("defaultRatingProject", () => {
  const project = (id: string, workingToday: number) => ({ id, workingToday });

  it("opens on the first project where anyone is working today", () => {
    const projects = [project("juja", 0), project("ruiru", 12), project("kitengela", 4)];
    expect(defaultRatingProject(projects)?.id).toBe("ruiru");
  });

  it("falls back to the first project when nobody is working anywhere today", () => {
    expect(defaultRatingProject([project("juja", 0), project("ruiru", 0)])?.id).toBe("juja");
    expect(defaultRatingProject([])).toBeUndefined();
  });
});
