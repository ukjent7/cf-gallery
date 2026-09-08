import { describe, expect, test } from "bun:test";
import { coverUrl, parseSampleMax, productUrl, sampleUrl } from "../src/index.js";

describe("upstream URL builders", () => {
  test("cover / sample / product URLs", () => {
    expect(coverUrl("877358")).toBe("https://www.getchu.com/brandnew/877358/rc877358package.jpg");
    expect(sampleUrl("877358", 2)).toBe("https://www.getchu.com/brandnew/877358/c877358sample2.jpg");
    expect(productUrl("877358")).toBe("https://www.getchu.com/soft.phtml?id=877358");
  });

  test("every URL stays on www.getchu.com", () => {
    for (const u of [coverUrl("1"), sampleUrl("1", 1), productUrl("1")]) {
      expect(new URL(u).hostname).toBe("www.getchu.com");
    }
  });
});

describe("parseSampleMax", () => {
  test("takes the largest sample index", () => {
    const html = '<img src="c877358sample1.jpg"><img src="c877358sample7.jpg"><img src="c877358sample3.jpg">';
    expect(parseSampleMax("877358", html)).toBe(7);
  });

  test("ignores other products and returns 0 when absent", () => {
    expect(parseSampleMax("877358", '<img src="c123sample9.jpg">')).toBe(0);
    expect(parseSampleMax("877358", "no images")).toBe(0);
  });
});
