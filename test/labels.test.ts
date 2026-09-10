import { describe, expect, it } from "vitest";
import { humanise } from "../src/labels";

describe("humanise", () => {
  it("keeps acronyms capitalised", () => {
    // Title-casing would give "Ncr", which reads as a word rather than an acronym.
    expect(humanise("ncr")).toBe("NCR");
    expect(humanise("NCR")).toBe("NCR");
  });

  it("renders the not-applicable status as a fraction, not two initials", () => {
    expect(humanise("n_a")).toBe("N/A");
  });

  it("puts the apostrophe back into cant_close", () => {
    expect(humanise("cant_close")).toBe("Can't close");
  });

  it("title-cases everything else", () => {
    expect(humanise("in_progress")).toBe("In Progress");
    expect(humanise("hold_point")).toBe("Hold Point");
    expect(humanise("defect")).toBe("Defect");
  });

  it("falls back to a dash rather than an empty cell", () => {
    expect(humanise(null)).toBe("—");
    expect(humanise("")).toBe("—");
  });
});
