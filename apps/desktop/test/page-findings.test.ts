import { describe, expect, it } from "vitest";
import { MEASURE_SCRIPT, pageFindings, type PageMeasure } from "../src/main/page-findings";

const fine: PageMeasure = {
  height: 5800,
  overflow: 0,
  h1: 1,
  imagesWithoutAlt: 0,
  brokenImages: 0,
  invisibleText: 0,
  title: "RankFlow | SEO services",
  hasDescription: true,
  hasOpenGraph: true,
  hasFavicon: true,
  unlabeledFields: 0,
};

describe("what a browser measures about a page", () => {
  it("finds nothing on a page that is in order", () => {
    expect(pageFindings(fine, [], 390, true)).toEqual([]);
  });

  it("reports width-specific problems per viewport and the rest once", () => {
    const m: PageMeasure = { ...fine, overflow: 130, invisibleText: 2, h1: 0, imagesWithoutAlt: 1, brokenImages: 3, hasOpenGraph: false, hasFavicon: false, unlabeledFields: 2, title: " " };
    expect(pageFindings(m, ["Uncaught ReferenceError: gsap is not defined", "Uncaught ReferenceError: gsap is not defined"], 390, true)).toEqual([
      "At 390 px wide the page scrolls sideways: its content is 520 px wide.",
      "At 390 px wide, 2 elements with text are still invisible (opacity 0) after scrolling through the page: an animation that never ran.",
      "Console error: Uncaught ReferenceError: gsap is not defined",
      "3 images don't load.",
      "The page has no h1.",
      "1 image has no alt attribute.",
      "2 form fields have no label.",
      "The page has no <title>.",
      "The page has no Open Graph tags (og:title, og:description).",
      "The page has no favicon link.",
    ]);
    // The second viewport repeats only what depends on width.
    expect(pageFindings({ ...m, overflow: 0, invisibleText: 1 }, ["x"], 1280, false)).toEqual([
      "At 1280 px wide, 1 element with text is still invisible (opacity 0) after scrolling through the page: an animation that never ran.",
    ]);
    expect(pageFindings({ ...fine, h1: 3, hasDescription: false }, [], 390, true)).toEqual(["The page has 3 h1 headings; it should have one.", "The page has no meta description."]);
  });

  it("measures inside the page with a script that is valid JavaScript", () => {
    expect(() => new Function(`return ${MEASURE_SCRIPT}`)).not.toThrow();
  });

  it("reports design problems a screenshot shows: emoji as pictures, everything centred, empty sections", () => {
    const m: PageMeasure = { ...fine, emojiPictures: 4, centredShare: 0.9, emptySections: [{ name: "#hero", empty: 420 }] };
    expect(pageFindings(m, [], 1280, true)).toEqual([
      "At 1280 px wide, #hero has about 420 px of empty space above and below its content: remove the min-height or large padding.",
      "4 emoji are used as a picture or icon. Replace each with the user's image or a labelled photo place (figure.photo), or remove it.",
      "Nearly all the text is centred, which reads as a template. Left-align the sections; centre at most one short statement.",
    ]);
    // Width-independent ones are said once.
    expect(pageFindings({ ...m, emptySections: [] }, [], 390, false)).toEqual([]);
    expect(MEASURE_SCRIPT).toContain("emojiPictures");
  });

  it("reports what search engines and link previews will miss", () => {
    const m: PageMeasure = { ...fine, title: "x".repeat(72), descriptionLength: 40, hasCanonical: false, hasStructuredData: false, hasShareImage: false, skippedHeadings: 1, unsizedImages: 2, vagueLinks: 1 };
    expect(pageFindings(m, [], 1280, true)).toEqual([
      "The <title> is 72 characters; search results cut it off after about 60.",
      "The meta description is 40 characters; aim for 120 to 155 so it isn't cut off or thin.",
      "The page has no JSON-LD structured data (schema.org LocalBusiness, Organization or Person).",
      "1 heading skips a level (for example an h3 straight after an h1).",
      "2 images have no width and height attributes, so the page jumps as they load.",
      '1 link says only "click here" or "read more"; say where the link goes.',
    ]);
  });
});
