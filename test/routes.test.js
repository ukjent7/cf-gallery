import { describe, expect, test } from "bun:test";
import { isValidCid, isValidSampleN, parseRoute } from "../src/index.js";

describe("parseRoute", () => {
  test("meta / cover / sample paths", () => {
    expect(parseRoute("/gc/meta/877358")).toEqual({ kind: "meta", cid: "877358" });
    expect(parseRoute("/gc/cover/877358.jpg")).toEqual({ kind: "cover", cid: "877358" });
    expect(parseRoute("/gc/sample/877358/3.jpg")).toEqual({ kind: "sample", cid: "877358", n: 3 });
  });

  test("unknown paths and bad ids are null", () => {
    expect(parseRoute("/gc/meta/abc")).toBeNull();
    expect(parseRoute("/gc/meta/877358/")).toBeNull();
    expect(parseRoute("/gc/cover/877358.png")).toBeNull();
    expect(parseRoute("/gc/sample/877358/0.jpg")).toBeNull();
    expect(parseRoute("/gc/sample/877358/41.jpg")).toBeNull();
    expect(parseRoute("/index.html")).toBeNull();
  });
});

describe("cid / n validation", () => {
  test("cid must be all digits", () => {
    expect(isValidCid("877358")).toBe(true);
    expect(isValidCid("")).toBe(false);
    expect(isValidCid("12a4")).toBe(false);
    expect(isValidCid("../877358")).toBe(false);
  });

  test("n is an integer in 1..40", () => {
    expect(isValidSampleN(1)).toBe(true);
    expect(isValidSampleN(40)).toBe(true);
    expect(isValidSampleN(0)).toBe(false);
    expect(isValidSampleN(41)).toBe(false);
    expect(isValidSampleN(1.5)).toBe(false);
  });
});
