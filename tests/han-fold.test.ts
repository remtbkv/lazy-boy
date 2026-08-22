// Han folding, pinned with the cases from Rem's own store on 2026-08-22 — the search that
// found nothing, and the two library rows that are the same song under two scripts.
import { describe, expect, it } from "vitest";
import { hanFold } from "@/lib/han-fold";
import { fuzzyFilter } from "@/lib/filter";

describe("hanFold", () => {
  it("folds the title Rem searched onto the one his library holds", () => {
    // He typed the simplified form; the library row is traditional (track 0K2Uk…, playlist
    // member, artist "Ada Zhuang").
    expect(hanFold("再见只是陌生人")).toBe("再见只是陌生人");
    expect(hanFold("再見只是陌生人")).toBe("再见只是陌生人");
  });

  it("collapses the same song stored under both scripts", () => {
    // Both of these are in his playlists, as separate track ids.
    expect(hanFold("兩個人的回憶一個人過")).toBe(hanFold("两个人的回忆一个人过"));
  });

  it("folds artist names too, so one artist is one row", () => {
    expect(hanFold("黃明昊")).toBe(hanFold("黄明昊"));
  });

  it("lower-cases, and leaves Latin text alone", () => {
    expect(hanFold("Ada Zhuang")).toBe("ada zhuang");
    expect(hanFold("BLACKPINK")).toBe("blackpink");
    // Punctuation, spacing and digits pass through untouched.
    expect(hanFold("時間煮雨（電影《小時代》主題宣傳曲）")).toBe(
      "时间煮雨（电影《小时代》主题宣传曲）",
    );
  });

  it("is idempotent — folding a folded string changes nothing", () => {
    for (const s of ["再見只是陌生人", "路過人間", "Ada Zhuang", "好朋友只是朋友"]) {
      expect(hanFold(hanFold(s))).toBe(hanFold(s));
    }
  });

  it("stays aligned past the astral mappings", () => {
    // A few simplified variants sit outside the BMP (㠣 → 𫵷, U+2B577). Building the table by
    // string INDEX rather than by code point desynchronised it at the first one and quietly
    // mapped everything after to the wrong character — 見 came out as 蜗. Both halves of that
    // are pinned here, so a regenerated table cannot reintroduce it silently.
    expect(hanFold("㠣")).toBe("𫵷");
    expect(hanFold("見")).toBe("见");
    expect(hanFold("龜")).toBe("龟"); // the last pair in the table
  });

  it("does not touch simplified-only characters or kana", () => {
    expect(hanFold("过客")).toBe("过客");
    expect(hanFold("ひらがな")).toBe("ひらがな");
  });

  it("keeps distinct songs distinct (the fold is not a fuzzy match)", () => {
    expect(hanFold("再見")).not.toBe(hanFold("再遇"));
    expect(hanFold("好可惜")).not.toBe(hanFold("好朋友"));
  });
});

describe("fuzzyFilter, folded", () => {
  const names = ["再見只是陌生人", "再遇不到你这样的人", "Manta Rays", "路過人間"];

  it("finds a traditional title from a simplified query and vice versa", () => {
    expect(fuzzyFilter(names, "再见只是陌生人", (n) => n)).toEqual(["再見只是陌生人"]);
    expect(fuzzyFilter(names, "路过人间", (n) => n)).toEqual(["路過人間"]);
    expect(fuzzyFilter(names, "再遇不到你這樣的人", (n) => n)).toEqual(["再遇不到你这样的人"]);
  });

  it("still does what it did before for Latin names", () => {
    expect(fuzzyFilter(names, "manta", (n) => n)).toEqual(["Manta Rays"]);
    expect(fuzzyFilter(names, "rays manta", (n) => n)).toEqual(["Manta Rays"]);
    expect(fuzzyFilter(names, "", (n) => n)).toEqual(names);
    expect(fuzzyFilter(names, "nope", (n) => n)).toEqual([]);
  });
});
