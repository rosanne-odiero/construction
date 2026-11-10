import { expect, it } from "vitest";
import manifest from "./manifest";

it("exposes a same-origin install manifest without claiming offline data access", () => {
  expect(manifest()).toMatchObject({
    id: "/",
    start_url: "/foundation",
    scope: "/",
    display: "standalone",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  });
});
