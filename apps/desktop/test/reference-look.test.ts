import { describe, expect, it } from "vitest";
import { isPublicPage } from "../src/main/reference-look";

describe("design reference links", () => {
  it("opens public web pages only", () => {
    for (const url of ["https://stripe.com/", "http://example.org/pricing", "https://8.8.8.8/"]) expect(isPublicPage(url), url).toBe(true);
    for (const url of ["file:///etc/passwd", "http://localhost:3000", "http://127.0.0.1:8000/v1", "http://192.168.1.10/", "http://10.0.0.5/", "http://172.20.1.1/", "http://169.254.169.254/latest", "http://[::1]/", "http://printer.local/", "http://intranet/", "javascript:alert(1)", "not a url"]) expect(isPublicPage(url), url).toBe(false);
  });
});
